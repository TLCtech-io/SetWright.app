// The drafter: a funnel.
//
//   ALL SONGS -> feasibility -> readiness -> context -> select + sequence
//
// The first three stages cross-check what a human misses by hand. Selection
// fills to length. Sequence orders the chosen pool into a starting arc and
// reports per-seam diagnostics (seams) and the order's total cost (sequenceCost)
// on DraftResult. The director finishes the order by hand.

import type {
    DraftInput,
    ID,
    ResolvedEvent,
    SetBreak,
    Song,
    VarietyConfig,
} from "../types.js";
import { DEFAULT_READINESS_FLOOR } from "../types.js";
import { indexBySong, indexByPart } from "../group.js";
import { checkFeasibility } from "./feasibility.js";
import { checkReadiness, readinessRank } from "./readiness.js";
import { checkContext } from "./context.js";
import {
    byPreferThenScore,
    byScoreThenId,
    clockSeconds,
    segmentOrder,
    selectToLength,
    stageTime,
    type Scored,
} from "./selection.js";
import { sequence, type Seam, type SequenceConfig } from "./sequence.js";
import { computeChase, type ChaseCandidate } from "./chase.js";
import { resolveForced } from "./options.js";
import { renderShortfall, type Drop } from "./diagnostics.js";

export interface SetEntry {
    song: Song;
    stage: number; // padded seconds
    // A bench song gone cold: performance-viable but not rehearsed in 90+ days by the
    // event date. Set only on bench entries, so the "not in the set" view can flag them
    // for a run. Absent on set entries, where placement, not staleness, is the story.
    stale?: boolean;
}

// The set is an ordered list of songs and breaks interleaved (the running order as
// the director reads it). A break takes no stage slot but holds clock time and splits
// the set into independently-sequenced segments.
export type SongItem = SetEntry & { kind: "song" };
export interface BreakItem {
    kind: "break";
    break: SetBreak;
}
export type SetItem = SongItem | BreakItem;

export const isSongItem = (item: SetItem): item is SongItem =>
    item.kind === "song";
export const isBreakItem = (item: SetItem): item is BreakItem =>
    item.kind === "break";
/** The song entries of a set, breaks dropped. The one-word narrowing for song-only consumers. */
export const songsOf = (set: SetItem[]): SongItem[] => set.filter(isSongItem);
/** The breaks of a set, in order. */
export const breaksOf = (set: SetItem[]): SetBreak[] =>
    set.filter(isBreakItem).map((i) => i.break);

/**
 * Interleave breaks into a song-item list at their ordinal slots (afterPosition = the
 * gap after the k-th song). The single place songs and breaks are woven into one set —
 * the drafter and the read-only views build the set through here. At most one break per
 * slot (first wins), so it stays correct even if a caller passes un-deduped breaks.
 */
export function interleaveBreaks(
    songItems: SongItem[],
    breaks: SetBreak[],
): SetItem[] {
    const breakAfter = new Map<number, SetBreak>();
    for (const b of breaks)
        if (!breakAfter.has(b.afterPosition))
            breakAfter.set(b.afterPosition, b);
    const set: SetItem[] = [];
    songItems.forEach((it, i) => {
        set.push(it);
        const b = breakAfter.get(i + 1);
        if (b) set.push({ kind: "break", break: b });
    });
    return set;
}

export interface DraftResult {
    set: SetItem[]; // ordered; songs and breaks interleaved, the arc lives in the order
    bench: SetEntry[]; // ready, coverable, appropriate, but did not fit the target; best first
    totalSeconds: number;
    targetSeconds: number | null;
    seams: Seam[]; // adjacent-pair diagnostics: cost and director-facing flags
    sequenceCost: number; // total objective of the order, lower is better
    shortfall: string | null; // null when the target is met (or absent)
    drops: Drop[]; // every song that fell out, and where
    // Forced ids (open/close/keep) the hydrated pool does not contain: a stale pin
    // against an archived or deleted song (hydrate returns active rows only, while
    // the locks doc may still carry the id). No Song row exists to report as a
    // drop, so the raw ids surface here; a forced pin must never vanish silently.
    // Optional so hand-built results (the frozen performed-set view) stay valid;
    // draftSet always sets it.
    unknownForcedIds?: ID[];
    // Required tags (context.requireTags) no available song carries, so the set cannot
    // satisfy the mandate. A set-level lever the shortfall names. Optional for the same
    // reason as unknownForcedIds; draftSet always sets it.
    requiredMisses?: ID[];
}

// Scoring weights. Readiness dominates; the rest break ties.
const W_READINESS = 3;
const W_CONFIDENCE = 1;
const W_PREFERENCE = 1;
const W_RECENCY = 1;
// Staleness is a gentle tie-breaker: a ready song gone cold (not rehearsed in a
// while) sorts a touch under a fresh one, so it tends to fall to the bench where the
// "gone cold" callout flags it. It never gates — the director keeps the call.
const W_STALENESS = 1;

// A stable [0,1) hash of a string, for the variety jitter. Per-song and
// order-independent, so a given (seed, songId) always lands the same nudge: a
// fresh seed reshuffles the pool, the same seed reproduces it. No Math.random,
// so the drafter stays pure and testable.
function hashUnit(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

/** Seeded score nudge in [-amount, +amount] for one song. 0 when off. A
 *  non-finite amount (NaN or Infinity from a bad payload) is no variety, not a
 *  poison value that would send NaN through every score. */
function varietyJitter(song: Song, variety: VarietyConfig | undefined): number {
    if (!variety || !Number.isFinite(variety.amount) || variety.amount <= 0)
        return 0;
    return (hashUnit(`${variety.seed}:${song.id}`) - 0.5) * 2 * variety.amount;
}

// Below this fraction of the target, explain the shortfall.
const FILL_THRESHOLD = 0.95;

// Hard cap on the pool the sequencer orders. greedyOrder is O(n^2) and the cleanup is O(n^2) per
// step, so with no target (every qualified song is selected) a huge repertoire would pin the CPU.
// A real set is far under this; beyond it the best-scoring songs are sequenced and the rest fall to
// the bench. Insurance against an unbounded server-built pool, not a tuning knob.
const MAX_SEQUENCE_SONGS = 256;

export function draftSet(
    input: DraftInput,
    config?: SequenceConfig,
): DraftResult {
    const { songs, parts, castings, availability, event } = input;
    const opt = input.options ?? {};
    const readinessFloor = opt.readinessFloor ?? DEFAULT_READINESS_FLOOR;
    const padding = event.padding;

    // Three director buckets. Open pins the start, close pins the end, keep
    // forces a song in with a flexible position. All three skip the gates and
    // win over an exclude. Resolved by the shared helper so the chase lever agrees.
    const { open, close, keepIds, forcedIds } = resolveForced(opt);

    const excluded = new Set(opt.excluded ?? []);
    for (const id of forcedIds) excluded.delete(id);

    // Preferred (prep) songs the director committed to this gig. They bypass the soft gates like
    // a keep, but stay feasibility- and budget-gated. A song that is also a hard pin/keep is
    // already forced, and an excluded song stays out, so neither belongs in the preferred set.
    const preferIds = new Set(
        (opt.prefer ?? []).filter(
            (id) => !forcedIds.has(id) && !excluded.has(id),
        ),
    );

    // Indexes.
    const partsBySong = indexBySong(parts);
    const castingsByPart = indexByPart(castings);
    // Availability is already scoped to the one event by the query, so there is
    // no event filter here.
    const availableMemberIds = new Set<ID>();
    for (const a of availability) {
        if (a.status === "in") availableMemberIds.add(a.memberId);
        if (a.status === "tentative" && opt.countTentativeAsAvailable) {
            availableMemberIds.add(a.memberId);
        }
    }

    const songsById = new Map(songs.map((s) => [s.id, s]));

    // A forced id the pool does not contain (a stale pin: the song was archived or
    // deleted after the lock was set; hydrate returns active rows only) cannot be
    // drafted, and there is no Song row to report as a drop. Surface the raw ids so
    // the pin never vanishes from the set, the bench, and the drops all at once.
    const unknownForcedIds = [...forcedIds].filter((id) => !songsById.has(id));

    const drops: Drop[] = [];
    const qualified: Scored[] = [];

    for (const song of songs) {
        if (excluded.has(song.id)) continue;
        if (forcedIds.has(song.id)) continue; // forced songs skip the gates

        const isPrefer = preferIds.has(song.id);
        const sParts = partsBySong.get(song.id) ?? [];
        const stage = stageTime(song, padding); // number | null

        // Feasibility is the hard gate, so it gates preferred songs too: a prep commitment the
        // available cast cannot cover falls out here rather than forcing the set short a part.
        const feas = checkFeasibility({
            songIndex: { song, parts: sParts },
            castingsByPart,
            availableMemberIds,
        });
        if (!feas.feasible) {
            drops.push({
                song,
                stage: "feasibility",
                detail: feas.shortParts.map((s) => s.label).join(", "),
                stageSeconds: stage ?? 0,
            });
            continue;
        }

        // Readiness and context are the soft gates. A preferred song overrides them (the director
        // committed to it), but the checks still run because their scores order the pool.
        const read = checkReadiness({
            song,
            parts: sParts,
            castingsByPart,
            availableMemberIds,
            event,
            readinessFloor,
        });
        if (!read.eligible && !isPrefer) {
            const detail =
                read.reason === "on-book-not-allowed"
                    ? "on-book (mode)"
                    : `${song.assessedReadiness} (below floor)`;
            drops.push({
                song,
                stage: "readiness",
                detail,
                stageSeconds: stage ?? 0,
            });
            continue;
        }

        const ctx = checkContext(song, event, opt.context);
        if (!ctx.eligible && !isPrefer) {
            const detail =
                ctx.reason === "explicit"
                    ? "explicit"
                    : ctx.reason === "accompaniment"
                      ? "accompaniment"
                      : (ctx.excludedBy ?? "context");
            drops.push({
                song,
                stage: "context",
                detail,
                stageSeconds: stage ?? 0,
            });
            continue;
        }

        // Qualified, but no chart length means it cannot be length-placed. Record
        // the data gap rather than guessing a duration.
        if (stage === null) {
            drops.push({
                song,
                stage: "data",
                detail: "no duration set",
                stageSeconds: 0,
            });
            continue;
        }

        // A preferred song that bypassed the readiness floor still gets its true rank, so the
        // preferred tier fills most-ready first when the budget cannot hold every commitment.
        const readinessScore = isPrefer
            ? readinessRank(song)
            : read.readinessScore;
        const score =
            readinessScore * W_READINESS -
            read.soloConfidencePenalty * W_CONFIDENCE +
            ctx.preferenceBoost * W_PREFERENCE -
            recency(song, event.eventDate) * W_RECENCY -
            staleness(song, event.eventDate) * W_STALENESS +
            varietyJitter(song, opt.variety);

        qualified.push({ song, stage, score, prefer: isPrefer });
    }

    // Forced songs go in regardless of the gates, at score Infinity.
    const openScored = scoreForced(open, songsById, padding);
    const closeScored = scoreForced(close, songsById, padding);
    const keepScored = keepIds
        .map((id) => scoreForced(id, songsById, padding))
        .filter((s): s is Scored => s !== undefined);
    const forced: Scored[] = [
        ...(openScored ? [openScored] : []),
        ...(closeScored ? [closeScored] : []),
        ...keepScored,
    ];

    // Reserve the one-time per-set overhead AND any break time off the top, then fill
    // the rest — so the set sizes around the breaks the director placed.
    const target = event.targetDurationSeconds;
    const hasTarget = target !== null;
    // Two-tier length control. target is the soft goal (bias under, warn when short); the
    // hard cap is a ceiling the set must never exceed. The fill/trim honor the TIGHTER of
    // the two (so with no target, a cap alone still bounds the fill), while the under-fill
    // warning stays keyed on target. cap >= target by the schema check, so when a target is
    // set the fill is governed by the target and the cap only catches pin/segue overshoot.
    const cap = event.maxDurationSeconds;
    const fillLimit = Math.min(target ?? Infinity, cap ?? Infinity);
    const hasFillLimit = Number.isFinite(fillLimit);
    // Dedupe the requested breaks by their slot up front (song-count-independent: a
    // duplicate slot is one break regardless of how many songs fit), so the budget reserves
    // one duration per slot — not two for a collision the render would merge.
    const requestedBreaks = dedupeBreaksBySlot(input.breaks ?? []);
    // The selection budget reserves the SIGNED net break cost: a break REPLACES the inter-song gap at
    // its slot (clockSeconds counts the break in place of the gap), so the true cost is
    // (break − gap), which is NEGATIVE for a break shorter than the gap — a short break GIVES BACK
    // fill room. Keep the sign rather than clamp to 0: clamping over-charges a short break and strands
    // a song that fits exactly. The estimate is still approximate (it can't know which gaps normalize/merge before
    // the order exists), so the assembly reconciles it against the real clock in BOTH directions: the
    // trim loop removes on overrun, the add-back loop restores on underfill.
    const budgetBreakSeconds = requestedBreaks.reduce(
        (sum, b) =>
            sum + (Math.round(b.durationSeconds) - padding.perSongSeconds),
        0,
    );
    // The per-song transition overrides (segues) feed selection (so the fill honors the real clock,
    // not a uniform-gap estimate that under-fills then cries shortfall, or overruns on long segues)
    // and the sequencer below.
    const transitionOut = new Map<ID, number>(
        Object.entries(input.transitionOut ?? {}),
    );
    const { chosen: chosenFull } = selectToLength(
        qualified,
        {
            targetSeconds: hasFillLimit ? fillLimit : Infinity,
            perSetSeconds: padding.perSetSeconds,
            breakSeconds: budgetBreakSeconds,
            perSongGapSeconds: padding.perSongSeconds,
            transitionOut,
        },
        forced,
    );
    // Bound the pool the sequencer orders, INCLUDING the forced keeps and the open/close pins — an
    // unbounded keep list (a 500-id pin payload) would otherwise sail past the cap and produce an
    // O(n^2) set. Reserve the pins, keep as many pins/keeps as fit (keeps are score-descending too),
    // then fill the rest from chosen (also score-descending). The overflow falls to the bench below.
    const pinReserve = (openScored ? 1 : 0) + (closeScored ? 1 : 0);
    const keepRoom = Math.max(0, MAX_SEQUENCE_SONGS - pinReserve);
    const cappedKeep = keepScored.slice(0, keepRoom);
    // A director's explicit pins beyond the sequencer cap cannot be ordered. Record them as drops
    // (stage 'capacity') rather than silently discarding them — a forced keep must never vanish from
    // the set, the bench, AND the drops at once. (open/close are 0–2 pins and always fit under the cap.)
    for (const s of keepScored.slice(keepRoom)) {
        drops.push({
            song: s.song,
            stage: "capacity",
            detail: `over the ${MAX_SEQUENCE_SONGS}-song sequencer cap`,
            stageSeconds: s.stage,
        });
    }
    const seqRoom = Math.max(
        0,
        MAX_SEQUENCE_SONGS - pinReserve - cappedKeep.length,
    );
    const chosen =
        chosenFull.length > seqRoom ? chosenFull.slice(0, seqRoom) : chosenFull;

    // Order the chosen pool. Open and close pins bracket the middle (keep + chosen);
    // the sequencer lays out a starting arc the director finishes.
    const seqInput = {
        open: openScored?.song,
        close: closeScored?.song,
        partsBySong,
        castingsByPart,
        perSongGapSeconds: padding.perSongSeconds,
        transitionOut,
        // The same available set the gates used, so the soloist term tracks the cover who will
        // actually sing a line when the primary is out — consistent with feasibility/readiness.
        availableMemberIds,
        config,
    };
    // Assemble a set from a middle song list: one global pass orders the pool and assigns songs to
    // segments; with breaks, re-sequence each segment independently — a hard flow-reset, no key decay
    // or arc carry across a break — with the global open/close pinning only the first segment's head
    // and the last segment's tail. No breaks => the global order as-is. Returned with its authoritative
    // clock so the caller can trim against the target. Factored so it can re-run after a trim.
    const assemble = (
        middle: Song[],
    ): {
        songOrder: Song[];
        seams: Seam[];
        sequenceCost: number;
        breaks: SetBreak[];
        totalSeconds: number;
    } => {
        const globalSeq = sequence({ ...seqInput, middle });
        const breaks = normalizeBreaks(requestedBreaks, globalSeq.order.length);
        let songOrder: Song[];
        let seams: Seam[];
        let sequenceCost: number;
        if (breaks.length === 0) {
            songOrder = globalSeq.order;
            seams = globalSeq.seams;
            sequenceCost = globalSeq.cost;
        } else {
            songOrder = [];
            seams = [];
            sequenceCost = 0;
            const segments = segmentOrder(globalSeq.order, breaks);
            segments.forEach((seg, si) => {
                const segOpen = si === 0 ? openScored?.song : undefined;
                const segClose =
                    si === segments.length - 1 ? closeScored?.song : undefined;
                const segMiddle = seg.filter(
                    (s) => s.id !== segOpen?.id && s.id !== segClose?.id,
                );
                const segSeq = sequence({
                    ...seqInput,
                    middle: segMiddle,
                    open: segOpen,
                    close: segClose,
                });
                songOrder.push(...segSeq.order);
                seams.push(...segSeq.seams);
                sequenceCost += segSeq.cost;
            });
        }
        return {
            songOrder,
            seams,
            sequenceCost,
            breaks,
            totalSeconds: clockSeconds(
                songOrder,
                padding,
                transitionOut,
                breaks,
            ),
        };
    };

    // Selection admits a song when the set fits in its BEST order (the long-segue song placed last);
    // the sequencer may not realize that order, so trim the lowest-priority non-pinned song and
    // re-assemble until the produced clock fits the target. `chosen` is preferred-first then
    // score-descending (byPreferThenScore), so the last entry is the lowest-score non-preferred song
    // and the trim drops non-preferred before preferred; keepScored (forced) and the open/close pins
    // are never trimmed. With uniform gaps the best and worst orders coincide, so this loop never
    // fires there — the common no-segue draft never needs a trim.
    const kept = [...chosen];
    let asm = assemble([...cappedKeep, ...kept].map((s) => s.song));
    while (hasFillLimit && asm.totalSeconds > fillLimit && kept.length > 0) {
        kept.pop();
        asm = assemble([...cappedKeep, ...kept].map((s) => s.song));
    }
    // Reconcile UP: the pre-sequence break budget can UNDER-fill — a break shorter than the gap it
    // replaces gives back room the flat per-song estimate can't localize, and out-of-range break
    // positions normalize onto fewer slots than were reserved. The trim loop only removes, so pull the
    // best benched song that still fits the real clock and re-assemble, until none fits or the
    // sequencer cap is reached. Symmetric with the trim; a uniform no-break draft never enters (its
    // estimate is exact, so every candidate overruns and is skipped on the cheap duration check).
    // Preferred (prep) songs come first here too, so a reclaimed slot goes to a benched commitment
    // before a higher-scored non-preferred song — the same tier the initial fill and trim honor.
    if (hasFillLimit) {
        const placed = new Set([...cappedKeep, ...kept].map((s) => s.song.id));
        const addable = qualified
            .filter((s) => !placed.has(s.song.id))
            .sort(byPreferThenScore);
        for (const cand of addable) {
            if (kept.length >= seqRoom) break;
            // Adding a song grows the clock by at least its duration; skip a clear overrun without a
            // (costly) re-assemble. A shorter later candidate may still fit, so scan on rather than break.
            if (
                asm.totalSeconds + Math.round(cand.song.durationSeconds ?? 0) >
                fillLimit
            )
                continue;
            const trial = assemble(
                [...cappedKeep, ...kept, cand].map((s) => s.song),
            );
            if (trial.totalSeconds <= fillLimit) {
                kept.push(cand);
                asm = trial;
            }
        }
    }
    // Required-material post-check (set-level). The set must contain at least one song per
    // required tag. If the chosen set (pins + forced keeps + fill) carries none of a required
    // tag, guarantee one: promote a fill song that already carries it into the protected set,
    // else swap in the best qualified song that does, then trim the lowest-score non-required
    // fill to make room (required songs are never trimmed, like forced keeps). A tag no
    // qualified song carries is a lever, recorded in requiredMisses for the shortfall.
    const requireTags = opt.context?.requireTags ?? [];
    const requiredMisses: ID[] = [];
    const requiredKeeps: Scored[] = [];
    if (requireTags.length > 0) {
        const carries = (song: Song, tag: string): boolean =>
            song.tags.some((t) => t.name === tag);
        const pins = [openScored, closeScored].filter(
            (s): s is Scored => s !== undefined,
        );
        for (const tag of requireTags) {
            const protectedNow = [...cappedKeep, ...pins, ...requiredKeeps];
            if (protectedNow.some((s) => carries(s.song, tag))) continue; // already guaranteed
            // Prefer an already-selected fill carrier (moved out of the trimmable pool), else
            // pull the best qualified carrier not already placed.
            const idx = kept.findIndex((s) => carries(s.song, tag));
            if (idx >= 0) {
                requiredKeeps.push(kept.splice(idx, 1)[0]!);
                continue;
            }
            const placed = new Set(
                [...cappedKeep, ...pins, ...kept, ...requiredKeeps].map(
                    (s) => s.song.id,
                ),
            );
            const pick = qualified
                .filter((s) => !placed.has(s.song.id) && carries(s.song, tag))
                .sort(byScoreThenId)[0];
            if (pick) requiredKeeps.push(pick);
            else requiredMisses.push(tag);
        }
        if (requiredKeeps.length > 0) {
            asm = assemble(
                [...cappedKeep, ...requiredKeeps, ...kept].map((s) => s.song),
            );
            while (
                hasFillLimit &&
                asm.totalSeconds > fillLimit &&
                kept.length > 0
            ) {
                kept.pop();
                asm = assemble(
                    [...cappedKeep, ...requiredKeeps, ...kept].map(
                        (s) => s.song,
                    ),
                );
            }
        }
    }

    const { songOrder, seams, sequenceCost, breaks } = asm;

    // The bench: songs that cleared every gate and have a length, but did not make the final set
    // (did not fit the budget, or were trimmed for length). Best score first. Forced and excluded
    // songs never reach `qualified`, so they are correctly absent here. Required keeps are in the
    // set, so exclude them too.
    const chosenIds = new Set(
        [...kept, ...requiredKeeps].map((s) => s.song.id),
    );
    const bench: SetEntry[] = qualified
        .filter((s) => !chosenIds.has(s.song.id))
        .sort(byScoreThenId)
        .map((s) => ({
            song: s.song,
            stage: s.stage,
            stale: staleness(s.song, event.eventDate) > 0,
        }));

    // Interleave songs and breaks into the ordered set. A break sits after its (clamped) ordinal
    // song; the clock counts its time in place of the inter-song gap there. The shortfall verdict
    // reads the authoritative clock (totalSeconds), so it and the displayed wall stay in lockstep,
    // and a null-duration pinned song's missing time lowers the total honestly.
    const songItems: SongItem[] = songOrder.map((s) => ({
        kind: "song",
        song: s,
        stage: stageTime(s, padding) ?? 0,
    }));
    const set = interleaveBreaks(songItems, breaks);
    const totalSeconds = asm.totalSeconds;

    // A contradictory config (per-set overhead + net reserved break time >= target) leaves a negative
    // fill budget, so no song can be admitted and the set is overhead-only. totalSeconds then exceeds
    // the target (it is all overhead), which would silently suppress the fill-threshold shortfall
    // below — so name the impossible configuration explicitly instead of returning a quiet empty set.
    const overheadSeconds = padding.perSetSeconds + budgetBreakSeconds;
    // A required-material miss is a real failure even when the clock is full, so it forces the
    // shortfall on independent of the fill threshold (and independent of a target at all).
    const requireMiss = requiredMisses.length > 0;
    // Over the hard cap: only pins, forced keeps, required songs, or long segues can push a set
    // past the cap (the fill/trim keep the trimmable pool under it), so this names a lever the
    // trim cannot pull. Forces the shortfall on regardless of target/fill.
    const overCapSeconds =
        cap !== null && totalSeconds > cap ? totalSeconds - cap : 0;
    const shortfall =
        hasFillLimit && fillLimit <= overheadSeconds
            ? `The fixed overhead (${Math.round(overheadSeconds / 60)} min of per-set time and breaks) meets or exceeds the ${Math.round(fillLimit / 60)}-minute limit, so no songs fit. Raise the limit or reduce the overhead.`
            : (hasTarget && totalSeconds < target * FILL_THRESHOLD) ||
                requireMiss ||
                overCapSeconds > 0
              ? renderShortfall({
                    targetSeconds: target ?? totalSeconds,
                    filledSeconds: totalSeconds,
                    drops,
                    requiredMisses,
                    overCapSeconds,
                    capSeconds: cap,
                })
              : null;

    return {
        set,
        bench,
        totalSeconds,
        targetSeconds: target,
        seams,
        sequenceCost,
        shortfall,
        drops,
        unknownForcedIds,
        requiredMisses,
    };
}

/** Dedupe breaks by their requested slot (rounded afterPosition >= 1, first wins).
 *  Song-count-independent — the budget reservation reads this so it never double-counts a
 *  collision that the render would merge into one break. */
function dedupeBreaksBySlot(breaks: SetBreak[]): SetBreak[] {
    const seen = new Set<number>();
    const out: SetBreak[] = [];
    for (const b of breaks) {
        const pos = Math.round(b.afterPosition);
        if (pos < 1 || seen.has(pos)) continue;
        seen.add(pos);
        out.push(b);
    }
    return out;
}

/**
 * Clamp each break's afterPosition into [1, songCount-1] (it must sit between two
 * songs), dedupe by the clamped position (first wins), and sort. Fewer than two songs
 * admits no break. The single normalization both the assembly and the clock read; the
 * budget reserves dedupeBreaksBySlot time and the shortfall reconciles to THIS, so a
 * clamped/merged/dropped break never silently mis-sizes the set.
 */
export function normalizeBreaks(
    breaks: SetBreak[],
    songCount: number,
): SetBreak[] {
    if (songCount < 2) return [];
    const seen = new Set<number>();
    const out: SetBreak[] = [];
    for (const b of breaks) {
        const pos = Math.min(
            Math.max(1, Math.round(b.afterPosition)),
            songCount - 1,
        );
        if (seen.has(pos)) continue;
        seen.add(pos);
        out.push({ ...b, afterPosition: pos });
    }
    return out.sort((a, b) => a.afterPosition - b.afterPosition);
}

function scoreForced(
    id: ID | undefined,
    songsById: Map<ID, Song>,
    padding: ResolvedEvent["padding"],
): Scored | undefined {
    if (!id) return undefined;
    const song = songsById.get(id);
    if (!song) return undefined;
    return { song, stage: stageTime(song, padding) ?? 0, score: Infinity };
}

export interface DraftWithChase extends DraftResult {
    chase: ChaseCandidate[];
}

/**
 * draftSet plus the chase lever: which feasibility-blocked songs a chased RSVP
 * would open, and who to chase. Costs one extra feasibility pass; call this when
 * the shortfall should name the lever, not just the dead end.
 */
export function draftSetWithChase(
    input: DraftInput,
    config?: SequenceConfig,
): DraftWithChase {
    return { ...draftSet(input, config), chase: computeChase(input) };
}

/** Penalise songs performed recently, to spread repetition. */
function recency(song: Song, eventDateISO: string | null): number {
    if (!song.lastPerformed || !eventDateISO) return 0;
    const days =
        (Date.parse(eventDateISO) - Date.parse(song.lastPerformed)) /
        86_400_000;
    if (days < 30) return 2;
    if (days < 90) return 1;
    return 0;
}

/**
 * Penalise a song that has gone cold: not rehearsed in over 90 days. A missing
 * last_rehearsed is no signal, not evidence of coldness (null = unknown, matching
 * recency), so it never fires on data we do not have. The same 90-day line the
 * dashboard uses for recency, applied to rehearsal instead of performance.
 */
const STALE_AFTER_DAYS = 90;
function staleness(song: Song, eventDateISO: string | null): number {
    if (!song.lastRehearsed || !eventDateISO) return 0;
    const days =
        (Date.parse(eventDateISO) - Date.parse(song.lastRehearsed)) /
        86_400_000;
    return days > STALE_AFTER_DAYS ? 1 : 0;
}
