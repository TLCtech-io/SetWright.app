// Stage 4b: sequence.
//
// Order the chosen pool by minimizing one weighted sum of soft terms across
// adjacent pairs, plus an energy arc over the whole set, plus position rules on
// the ends. The director's pins win, and the director finishes by hand. None of
// this is the final word; it is a sane starting order.
//
// One frame, many terms. Each term is a separable function, normalized to about
// 0..1, then weighted. The weights are the real tuning surface and live in one
// config object. Missing data is no signal for that term, never a fabricated
// value: a keyless song scores no clash, an unrated song adds nothing to the arc.

import type { Casting, ID, KeySig, Part, Song, TagCategory } from "../types.js";
import { circleDistance, isRelativePair } from "../pitch.js";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

export interface KeyCostConfig {
    /** Cost for a relative major/minor move. Shared signature, smooth. */
    relativeCost: number;
    /** Gap in seconds at which the clash penalty halves. Smaller decays faster. */
    gapHalfLifeSeconds: number;
}

export const DEFAULT_KEY_COST: KeyCostConfig = {
    relativeCost: 0.5,
    gapHalfLifeSeconds: 6,
};

export interface SequenceWeights {
    key: number;
    intensityArc: number;
    flatline: number;
    tempo: number;
    density: number;
    soloist: number;
    variety: number;
}

export interface SequenceConfig {
    weights: SequenceWeights;
    keyCost: KeyCostConfig;
    flatBandIntensity: number; // |delta intensity| at/above which a seam is not flat
    tempoBandBpm: number; // |delta bpm| at/above which adjacent tempos read as varied
    densityCap: number; // sum of countNeeded treated as a full wall
    soloRecoveryWindow: number; // a featured lead within this many slots is a recovery clash
    peakFraction: number; // where the arc peak should sit, 0..1 (about two-thirds)
    cleanup: boolean; // run the local-search cleanup pass
    cleanupMaxMoves: number; // safety cap on improving moves; convergence usually stops first
    // Above this interior size, skip the cleanup pass. Each step is O(n^2) candidate moves
    // scoring the whole order (O(n)) — an O(n^3) step — so an unbounded pool (a runaway target,
    // a pathological input) could pin the CPU. A real set is far under this; beyond it the
    // greedy order stands rather than running the cliff. Insurance, not a behavior knob.
    cleanupMaxInteriorSongs: number;
}

export const DEFAULT_SEQUENCE_CONFIG: SequenceConfig = {
    weights: {
        key: 1,
        intensityArc: 1,
        flatline: 0.8,
        tempo: 0.3,
        density: 0.5,
        soloist: 0.8,
        variety: 0.6,
    },
    keyCost: DEFAULT_KEY_COST,
    flatBandIntensity: 2,
    tempoBandBpm: 16,
    densityCap: 8,
    soloRecoveryWindow: 2,
    peakFraction: 2 / 3,
    cleanup: true,
    cleanupMaxMoves: 256,
    cleanupMaxInteriorSongs: 64,
};

/** A finite, positive value, or the fallback. */
function posOr(v: number, fallback: number): number {
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Guard the divisions. flatBandIntensity, tempoBandBpm, gapHalfLifeSeconds, and densityCap are
 * divisors, and peakFraction feeds arcCost's Math.round; a zero, negative, or non-finite value in a
 * divisor (or a non-finite peakFraction) would send NaN through the seam costs and the whole
 * objective, out as a NaN sequenceCost. Degenerate values fall back to the defaults. The one place
 * config is sanitized; sequence, scoreOrder, and seamsFor all pass through here.
 */
function sanitizeConfig(cfg: SequenceConfig): SequenceConfig {
    const flat = posOr(
        cfg.flatBandIntensity,
        DEFAULT_SEQUENCE_CONFIG.flatBandIntensity,
    );
    const tempo = posOr(cfg.tempoBandBpm, DEFAULT_SEQUENCE_CONFIG.tempoBandBpm);
    const half = posOr(
        cfg.keyCost.gapHalfLifeSeconds,
        DEFAULT_KEY_COST.gapHalfLifeSeconds,
    );
    const dens = posOr(cfg.densityCap, DEFAULT_SEQUENCE_CONFIG.densityCap); // divisor in densitySeam
    // peakFraction is not a divisor but feeds Math.round(peakFraction*(n-1)); 0 is a legitimate value
    // (peak at the head), so guard finiteness only, not positivity.
    const peak = Number.isFinite(cfg.peakFraction)
        ? cfg.peakFraction
        : DEFAULT_SEQUENCE_CONFIG.peakFraction;
    if (
        flat === cfg.flatBandIntensity &&
        tempo === cfg.tempoBandBpm &&
        half === cfg.keyCost.gapHalfLifeSeconds &&
        dens === cfg.densityCap &&
        peak === cfg.peakFraction
    ) {
        return cfg;
    }
    return {
        ...cfg,
        flatBandIntensity: flat,
        tempoBandBpm: tempo,
        densityCap: dens,
        peakFraction: peak,
        keyCost: { ...cfg.keyCost, gapHalfLifeSeconds: half },
    };
}

// Thresholds for the director-facing seam flags. Qualitative, not the objective.
const FLAG_HARSH_KEY = 0.5; // normalized key cost (a move of 3+ on the circle, undiscounted)
const FLAG_FLATLINE = 0.5; // intensity delta within half the band reads as flat
const FLAG_TEMPO_BLUR = 0.75; // adjacent tempos within a quarter of the band
const FLAG_DENSITY_WALL = 0.75;
const FLAG_SAME_FEEL = 0.5; // half or more of the mood/groove/genre tags shared

// ----------------------------------------------------------------------------
// Key transition cost. Circle-of-fifths distance, with the relative-pair
// override and a gap discount. The geometry lives in pitch.ts; this is the
// cost wrapped around it.
// ----------------------------------------------------------------------------

function rawKeyCost(from: KeySig, to: KeySig, cfg: KeyCostConfig): number {
    if (isRelativePair(from, to)) return cfg.relativeCost;
    return circleDistance(from, to);
}

/** Fraction of the clash that survives the gap, 0..1. 1 at no gap. */
function gapDiscount(gapSeconds: number, cfg: KeyCostConfig): number {
    return Math.pow(0.5, Math.max(0, gapSeconds) / cfg.gapHalfLifeSeconds);
}

/**
 * Cost between two keys, discounted by the gap between the songs. 0 when either
 * key is unknown (free / rubato), since there is no defined clash. Raw range is
 * 0..6 (a tritone); the gap only shrinks it.
 */
export function keyTransitionCost(
    from: KeySig | null,
    to: KeySig | null,
    gapSeconds: number,
    cfg: KeyCostConfig = DEFAULT_KEY_COST,
): number {
    if (!from || !to) return 0;
    return rawKeyCost(from, to, cfg) * gapDiscount(gapSeconds, cfg);
}

/** The key a song leaves on. Falls back to its start key when it does not modulate. */
function outgoingKey(song: Song): KeySig | null {
    return song.endKey ?? song.startKey;
}

/** The key a song enters on. */
function incomingKey(song: Song): KeySig | null {
    return song.startKey;
}

// ----------------------------------------------------------------------------
// The other terms. Each returns a normalized penalty in 0..1, or 0 for no signal.
// ----------------------------------------------------------------------------

/** Normalized key clash at a seam, 0..1 (raw 0..6 over 6). */
function keySeam(a: Song, b: Song, gap: number, cfg: KeyCostConfig): number {
    return keyTransitionCost(outgoingKey(a), incomingKey(b), gap, cfg) / 6;
}

/** A near-zero intensity delta is a flat seam. 1 when identical, 0 at/beyond the band. */
function flatlineSeam(a: Song, b: Song, band: number): number {
    if (a.intensity === null || b.intensity === null) return 0;
    const d = Math.abs(a.intensity - b.intensity);
    return Math.max(0, (band - Math.min(d, band)) / band);
}

function outgoingTempo(song: Song): number | null {
    return song.endTempoBpm ?? song.startTempoBpm;
}

/** Near-identical adjacent tempos blur. 1 when identical, 0 at/beyond the band. */
function tempoSeam(a: Song, b: Song, band: number): number {
    const t1 = outgoingTempo(a);
    const t2 = b.startTempoBpm;
    if (t1 === null || t2 === null) return 0;
    const d = Math.abs(t1 - t2);
    return Math.max(0, (band - Math.min(d, band)) / band);
}

/** Density is the singer count: the sum of countNeeded over required parts. */
function density(songId: ID, partsBySong: Map<ID, Part[]>): number {
    const parts = partsBySong.get(songId) ?? [];
    return parts
        .filter((p) => p.isRequired)
        .reduce((s, p) => s + p.countNeeded, 0);
}

/** Two dense walls back to back. The product, so both must be dense to penalize. */
function densitySeam(
    a: Song,
    b: Song,
    partsBySong: Map<ID, Part[]>,
    cap: number,
): number {
    const da = Math.min(density(a.id, partsBySong) / cap, 1);
    const db = Math.min(density(b.id, partsBySong) / cap, 1);
    return da * db;
}

// Mood, groove, and genre diversify adjacency: two songs that share these feel
// tags read as samey back to back. Content gates appropriateness elsewhere and
// occasion is not a feel, so neither carries an adjacency signal.
const FEEL_CATEGORIES: ReadonlySet<TagCategory> = new Set([
    "mood",
    "groove",
    "genre",
]);

function feelTags(song: Song): Set<string> {
    const feel = new Set<string>();
    for (const t of song.tags) {
        if (t.category !== null && FEEL_CATEGORIES.has(t.category))
            feel.add(t.name);
    }
    return feel;
}

/** Overlap of two songs' feel tags, 0..1 (Jaccard). 1 = same feel, 0 = none shared or no signal. */
function varietySeam(a: Song, b: Song): number {
    const ta = feelTags(a);
    const tb = feelTags(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let shared = 0;
    for (const name of ta) if (tb.has(name)) shared += 1;
    const union = ta.size + tb.size - shared;
    return union === 0 ? 0 : shared / union;
}

/** The lowest member id wins a tie among castings, so the pick never depends on
 *  array order (the hydration provides none). */
function minByMember(casts: Casting[]): Casting | undefined {
    let best: Casting | undefined;
    for (const c of casts) {
        if (!best || c.memberId < best.memberId) best = c;
    }
    return best;
}

/**
 * The featured lead of a song: who actually takes the line on its featured single-seat
 * required part. The primary casting if they are available, else an available
 * cover; when no availability set is given the caller is availability-blind, so the
 * structural pick stands (primary, else a cast). Null when the song has no
 * featured line. Label-independent, so it does not depend on a part being named "Solo".
 *
 * Every pick has a defined order, because the hydration arrays carry no ORDER BY and
 * "first in the array" would leak physical row order into the seam costs: the featured
 * part is the smallest part id among cast single-seat required parts, and ties among
 * castings (several primaries, several available covers) resolve to the smallest
 * member id.
 *
 * Availability matters because the soloist term costs the same lead back to back: if the
 * primary is out, the cover is who sings it, so the clash (and the seam flag) must track
 * the cover, not a name on a chart no one will perform. When the whole cast is out the
 * song is infeasible and dropped upstream; fall back to the structural lead so a re-cost
 * still resolves a stable soloist for the seam rather than dropping to null.
 *
 * This is a per-song heuristic: it picks the FIRST available cover, which can differ from who
 * the global feasibility assignment actually places on the part (that matching may give the
 * first cover to another song's seat). So the soloist seam is advisory and can occasionally
 * over- or under-flag a back-to-back. Threading the exact per-song assignment (checkFeasibility
 * already returns it) through the sequencer and the re-cost path would make it exact; deferred
 * as a diagnostic refinement, not a correctness gate.
 */
function featuredLead(
    songId: ID,
    partsBySong: Map<ID, Part[]>,
    castingsByPart: Map<ID, Casting[]>,
    availableMemberIds?: Set<ID>,
): ID | null {
    const parts = (partsBySong.get(songId) ?? [])
        .filter((p) => p.isRequired && p.countNeeded === 1)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const p of parts) {
        const casts = castingsByPart.get(p.id) ?? [];
        if (casts.length === 0) continue;
        const primary =
            minByMember(casts.filter((c) => c.isPrimary)) ??
            minByMember(casts)!;
        if (!availableMemberIds || availableMemberIds.has(primary.memberId))
            return primary.memberId;
        const cover = minByMember(
            casts.filter((c) => availableMemberIds.has(c.memberId)),
        );
        return (cover ?? primary).memberId;
    }
    return null;
}

/** Same featured lead back to back, 0 or 1. Null leads never clash. */
function soloistSeam(leadA: ID | null, leadB: ID | null): number {
    if (leadA === null || leadB === null) return 0;
    return leadA === leadB ? 1 : 0;
}

/**
 * How far the order departs from the target arc, 0..1. Two features: the peak
 * (the most intense song) should sit near peakFraction, and a low-intensity dip
 * should sit in the middle third for contrast. Unrated songs carry no signal, so
 * fewer than two rated songs scores 0.
 */
function arcCost(order: Song[], peakFraction: number): number {
    const n = order.length;
    if (n < 2) return 0;
    const rated: { i: number; v: number }[] = [];
    order.forEach((s, i) => {
        if (s.intensity !== null) rated.push({ i, v: s.intensity });
    });
    if (rated.length < 2) return 0;

    let peak = rated[0]!;
    let dip = rated[0]!;
    for (const r of rated) {
        if (r.v > peak.v) peak = r;
        if (r.v < dip.v) dip = r;
    }

    const targetPeak = Math.round(peakFraction * (n - 1));
    const peakPenalty = Math.abs(peak.i - targetPeak) / (n - 1);

    const lo = Math.floor(n / 3);
    const hi = Math.ceil((2 * n) / 3) - 1;
    const dipPenalty =
        dip.i >= lo && dip.i <= hi
            ? 0
            : Math.min(Math.abs(dip.i - lo), Math.abs(dip.i - hi)) / (n - 1);

    return (peakPenalty + dipPenalty) / 2;
}

// Position fitness for choosing the ends when they are not pinned.

/** Opener: accessible, mid-to-high intensity (3..4), not the peak, not the floor. */
function openerFitness(song: Song): number {
    if (song.intensity === null) return 0.5; // no signal, neutral
    if (song.intensity === 3 || song.intensity === 4) return 1;
    if (song.intensity === 2 || song.intensity === 5) return 0.5;
    return 0.25; // intensity 1, too soft to open on
}

/** Closer: high intensity or the peak. The last thing they hear. */
function closerFitness(song: Song): number {
    if (song.intensity === null) return 0.5;
    return (song.intensity - 1) / 4; // 1 at intensity 5, 0 at intensity 1
}

// ----------------------------------------------------------------------------
// Objective and search
// ----------------------------------------------------------------------------

interface Ctx {
    partsBySong: Map<ID, Part[]>;
    perSongGapSeconds: number;
    // The gap LEAVING a song, in seconds: a per-song transition override (a segue =
    // 0) if the director set one, else the uniform per-song padding. This is the gap
    // the key clash decays over, so a 0-gap segue makes an adjacent clash matter more.
    gapFor: (id: ID) => number;
    leadOf: (id: ID) => ID | null;
}

// One place to build the seam/objective context. sequence(), scoreOrder(), and
// seamsFor() all share it, so each resolves the same featured lead per song and
// the by-hand re-score never disagrees with the sequencer.
function buildCtx(
    songs: Song[],
    partsBySong: Map<ID, Part[]>,
    castingsByPart: Map<ID, Casting[]>,
    perSongGapSeconds: number,
    transitionOut: Map<ID, number>,
    availableMemberIds?: Set<ID>,
): Ctx {
    const leadCache = new Map<ID, ID | null>();
    for (const s of songs) {
        leadCache.set(
            s.id,
            featuredLead(s.id, partsBySong, castingsByPart, availableMemberIds),
        );
    }
    return {
        partsBySong,
        perSongGapSeconds,
        gapFor: (id) => transitionOut.get(id) ?? perSongGapSeconds,
        leadOf: (id) => leadCache.get(id) ?? null,
    };
}

/** Weighted, normalized cost of placing `b` immediately after `a`. */
function pairwiseCost(a: Song, b: Song, ctx: Ctx, cfg: SequenceConfig): number {
    const w = cfg.weights;
    return (
        w.key * keySeam(a, b, ctx.gapFor(a.id), cfg.keyCost) +
        w.flatline * flatlineSeam(a, b, cfg.flatBandIntensity) +
        w.tempo * tempoSeam(a, b, cfg.tempoBandBpm) +
        w.density * densitySeam(a, b, ctx.partsBySong, cfg.densityCap) +
        w.soloist * soloistSeam(ctx.leadOf(a.id), ctx.leadOf(b.id)) +
        w.variety * varietySeam(a, b)
    );
}

// The soloist term has two facets here. Adjacency lives
// in pairwiseCost (distance 1). Recovery covers near-adjacency (distance 2 up to
// the window). Spread covers the rest: a lead clustered anywhere across the set.
// Each same-lead pair lands in exactly one facet, so nothing is double counted.

/** The same featured lead within the recovery window, beyond simple adjacency. */
function recoveryCost(order: Song[], ctx: Ctx, cfg: SequenceConfig): number {
    let total = 0;
    for (let i = 0; i < order.length; i++) {
        const li = ctx.leadOf(order[i]!.id);
        if (li === null) continue;
        for (let d = 2; d <= cfg.soloRecoveryWindow; d++) {
            const j = i + d;
            if (j >= order.length) break;
            if (ctx.leadOf(order[j]!.id) === li) {
                total +=
                    cfg.weights.soloist *
                    (1 - (d - 1) / cfg.soloRecoveryWindow);
            }
        }
    }
    return total;
}

/**
 * Spread distinct featured leads across the set. Beyond the recovery window, a
 * lead that reappears still costs, less with distance (1/gap), so the same lead
 * clustered through the set is penalized even when it is never near-adjacent.
 */
function spreadCost(order: Song[], ctx: Ctx, cfg: SequenceConfig): number {
    const positions = new Map<ID, number[]>();
    order.forEach((s, i) => {
        const lead = ctx.leadOf(s.id);
        if (lead === null) return;
        const at = positions.get(lead);
        if (at) at.push(i);
        else positions.set(lead, [i]);
    });
    let total = 0;
    for (const ps of positions.values()) {
        for (let a = 0; a < ps.length; a++) {
            for (let b = a + 1; b < ps.length; b++) {
                const gap = ps[b]! - ps[a]!;
                if (gap > cfg.soloRecoveryWindow)
                    total += cfg.weights.soloist / gap;
            }
        }
    }
    return total;
}

/** Total objective of a full ordering. Lower is better. */
function objective(order: Song[], ctx: Ctx, cfg: SequenceConfig): number {
    let total = 0;
    for (let i = 1; i < order.length; i++) {
        total += pairwiseCost(order[i - 1]!, order[i]!, ctx, cfg);
    }
    total += cfg.weights.intensityArc * arcCost(order, cfg.peakFraction);
    total += recoveryCost(order, ctx, cfg);
    total += spreadCost(order, ctx, cfg);
    return total;
}

function bestBy<T>(items: T[], score: (t: T) => number): T {
    let best = items[0]!;
    let bestScore = score(best);
    for (let i = 1; i < items.length; i++) {
        const sc = score(items[i]!);
        if (sc > bestScore) {
            best = items[i]!;
            bestScore = sc;
        }
    }
    return best;
}

/** Greedy: from a seed, repeatedly append the remaining song with the cheapest seam. */
function greedyOrder(
    seed: Song,
    pool: Song[],
    ctx: Ctx,
    cfg: SequenceConfig,
): Song[] {
    const order = [seed];
    const remaining = [...pool];
    let tail = seed;
    while (remaining.length) {
        let bestIdx = 0;
        let bestCost = Infinity;
        for (let k = 0; k < remaining.length; k++) {
            const c = pairwiseCost(tail, remaining[k]!, ctx, cfg);
            if (c < bestCost) {
                bestCost = c;
                bestIdx = k;
            }
        }
        tail = remaining[bestIdx]!;
        order.push(tail);
        remaining.splice(bestIdx, 1);
    }
    return order;
}

/** Move the song at `from` to position `to`. */
function relocate(items: Song[], from: number, to: number): Song[] {
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
}

/** Swap the songs at `i` and `j`. */
function swapped(items: Song[], i: number, j: number): Song[] {
    const next = items.slice();
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    return next;
}

/**
 * Local search over the interior, ends fixed. Greedy can corner itself, so from
 * the seed take the single best improving move until none improves. The moves
 * are relocate (pull any song out, reinsert anywhere) and swap (exchange any
 * two). Relocate subsumes adjacent swaps and reaches orders they cannot, so this
 * un-corners the greedy start. O(n^2) candidates per step, each scoring the whole
 * order, which is cheap for a set of at most a couple dozen songs.
 */
function localSearch(
    order: Song[],
    fixStart: boolean,
    fixEnd: boolean,
    ctx: Ctx,
    cfg: SequenceConfig,
): Song[] {
    const start = fixStart ? 1 : 0;
    const stop = fixEnd ? order.length - 1 : order.length;
    if (stop - start < 2) return order; // nothing interior to reorder
    // Guard the O(n^3) cliff: past the cap, keep the greedy order rather than searching.
    if (stop - start > cfg.cleanupMaxInteriorSongs) return order;

    const head = order.slice(0, start);
    const tail = order.slice(stop);
    const whole = (inner: Song[]): Song[] => [...head, ...inner, ...tail];

    let inner = order.slice(start, stop);
    let cost = objective(whole(inner), ctx, cfg);

    for (let step = 0; step < cfg.cleanupMaxMoves; step++) {
        let bestMove: Song[] | null = null;
        let bestCost = cost;
        const n = inner.length;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const cand = relocate(inner, i, j);
                const c = objective(whole(cand), ctx, cfg);
                if (c < bestCost - 1e-9) {
                    bestCost = c;
                    bestMove = cand;
                }
            }
        }
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const cand = swapped(inner, i, j);
                const c = objective(whole(cand), ctx, cfg);
                if (c < bestCost - 1e-9) {
                    bestCost = c;
                    bestMove = cand;
                }
            }
        }
        if (!bestMove) break; // converged: no single move improves
        inner = bestMove;
        cost = bestCost;
    }
    return whole(inner);
}

// ----------------------------------------------------------------------------
// Seam diagnostics
// ----------------------------------------------------------------------------

export type SeamFlag =
    | "harsh-key-change"
    | "energy-flatline"
    | "tempo-blur"
    | "density-wall"
    | "soloist-back-to-back"
    | "same-feel";

export interface Seam {
    fromId: ID;
    toId: ID;
    fromTitle: string;
    toTitle: string;
    cost: number; // the weighted pairwise part of the objective for this seam
    keyCost: number; // normalized, gap-discounted, 0..1
    flags: SeamFlag[];
}

function buildSeams(order: Song[], ctx: Ctx, cfg: SequenceConfig): Seam[] {
    const seams: Seam[] = [];
    for (let i = 1; i < order.length; i++) {
        const a = order[i - 1]!;
        const b = order[i]!;
        const keyNorm = keySeam(a, b, ctx.gapFor(a.id), cfg.keyCost);
        const flat = flatlineSeam(a, b, cfg.flatBandIntensity);
        const tempo = tempoSeam(a, b, cfg.tempoBandBpm);
        const dens = densitySeam(a, b, ctx.partsBySong, cfg.densityCap);
        const solo = soloistSeam(ctx.leadOf(a.id), ctx.leadOf(b.id));

        const flags: SeamFlag[] = [];
        if (keyNorm >= FLAG_HARSH_KEY) flags.push("harsh-key-change");
        // Threshold on the same flatline term the objective uses, so a near-flat seam
        // the sequencer penalized still shows the flag. flatlineSeam returns 0 for a
        // null intensity, so that case never flags.
        if (flat >= FLAG_FLATLINE) flags.push("energy-flatline");
        if (tempo >= FLAG_TEMPO_BLUR) flags.push("tempo-blur");
        if (dens >= FLAG_DENSITY_WALL) flags.push("density-wall");
        if (solo > 0) flags.push("soloist-back-to-back");
        if (varietySeam(a, b) >= FLAG_SAME_FEEL) flags.push("same-feel");

        seams.push({
            fromId: a.id,
            toId: b.id,
            fromTitle: a.title,
            toTitle: b.title,
            cost: pairwiseCost(a, b, ctx, cfg),
            keyCost: keyNorm,
            flags,
        });
    }
    return seams;
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

export interface SequenceInput {
    /** The songs to order. Open and close pins are separate and bracket these. */
    middle: Song[];
    open?: Song; // pinned opener, already chosen
    close?: Song; // pinned closer
    partsBySong: Map<ID, Part[]>;
    castingsByPart: Map<ID, Casting[]>;
    perSongGapSeconds: number; // the per-song padding, the default gap the key clash decays over
    // Per-song transition overrides (segues), keyed by the song the gap LEAVES. Absent
    // for a song = use perSongGapSeconds. Empty/omitted = uniform gaps (the auto-draft
    // has no segues until the director sets them on a concrete order).
    transitionOut?: Map<ID, number>;
    // Who is available for this event, so the soloist term tracks the cover who will
    // actually sing a line when the primary is out. Omitted = availability-blind (the
    // structural primary stands), preserving the call's behavior when not supplied.
    availableMemberIds?: Set<ID>;
    config?: SequenceConfig;
}

export interface SequenceResult {
    order: Song[];
    seams: Seam[];
    cost: number; // total objective of the final order, lower is better
}

export function sequence(input: SequenceInput): SequenceResult {
    const cfg = sanitizeConfig(input.config ?? DEFAULT_SEQUENCE_CONFIG);

    const allSongs = [
        ...(input.open ? [input.open] : []),
        ...(input.close ? [input.close] : []),
        ...input.middle,
    ];
    const ctx = buildCtx(
        allSongs,
        input.partsBySong,
        input.castingsByPart,
        input.perSongGapSeconds,
        input.transitionOut ?? new Map(),
        input.availableMemberIds,
    );

    let pool = [...input.middle];

    // Opener: the pin, else the best-fitting song in the pool.
    let opener: Song | undefined = input.open;
    if (!opener && pool.length) {
        opener = bestBy(pool, openerFitness);
        pool = pool.filter((s) => s.id !== opener!.id);
    }

    // Closer: the pin, else the best-fitting remaining song.
    let closer: Song | undefined = input.close;
    if (!closer && pool.length) {
        closer = bestBy(pool, closerFitness);
        pool = pool.filter((s) => s.id !== closer!.id);
    }

    // Order the interior greedily from the opener (or from the first song if there
    // is no opener at all), then bracket with the ends.
    let interior: Song[];
    if (opener) {
        interior = greedyOrder(opener, pool, ctx, cfg).slice(1);
    } else if (pool.length) {
        const seeded = greedyOrder(pool[0]!, pool.slice(1), ctx, cfg);
        interior = seeded;
    } else {
        interior = [];
    }

    const order = [
        ...(opener ? [opener] : []),
        ...interior,
        ...(closer ? [closer] : []),
    ];

    const finalOrder = cfg.cleanup
        ? localSearch(
              order,
              opener !== undefined,
              closer !== undefined,
              ctx,
              cfg,
          )
        : order;

    return {
        order: finalOrder,
        seams: buildSeams(finalOrder, ctx, cfg),
        cost: objective(finalOrder, ctx, cfg),
    };
}

/**
 * Score a given ordering against the objective, lower is better. The director
 * rearranges by hand; this re-costs the result without reordering it. The same
 * objective the sequencer minimizes, so the two always agree.
 */
export function scoreOrder(
    order: Song[],
    opts: {
        partsBySong: Map<ID, Part[]>;
        castingsByPart: Map<ID, Casting[]>;
        perSongGapSeconds: number;
        transitionOut?: Map<ID, number>;
        availableMemberIds?: Set<ID>;
        config?: SequenceConfig;
    },
): number {
    const cfg = sanitizeConfig(opts.config ?? DEFAULT_SEQUENCE_CONFIG);
    const ctx = buildCtx(
        order,
        opts.partsBySong,
        opts.castingsByPart,
        opts.perSongGapSeconds,
        opts.transitionOut ?? new Map(),
        opts.availableMemberIds,
    );
    return objective(order, ctx, cfg);
}

/**
 * Seam diagnostics for a given ordering. The director rearranges by hand; this
 * re-reads the seams for the new order without reordering it, so the client can
 * show the same flags the sequencer would. Same seam logic the sequencer emits,
 * so the two always agree.
 */
export function seamsFor(
    order: Song[],
    opts: {
        partsBySong: Map<ID, Part[]>;
        castingsByPart: Map<ID, Casting[]>;
        perSongGapSeconds: number;
        transitionOut?: Map<ID, number>;
        availableMemberIds?: Set<ID>;
        config?: SequenceConfig;
    },
): Seam[] {
    const cfg = sanitizeConfig(opts.config ?? DEFAULT_SEQUENCE_CONFIG);
    const ctx = buildCtx(
        order,
        opts.partsBySong,
        opts.castingsByPart,
        opts.perSongGapSeconds,
        opts.transitionOut ?? new Map(),
        opts.availableMemberIds,
    );
    return buildSeams(order, ctx, cfg);
}
