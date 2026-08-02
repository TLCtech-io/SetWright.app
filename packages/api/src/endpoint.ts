// POST /events/:id/draft-set, framework-agnostic.
//
// Wire it into any HTTP layer: pull the event id from the route, build a
// HydrationSource over the signed-in user's client, call this, and send back the
// status and body. The work is one read, one map, one draft. The hydration runs
// RLS-scoped as the caller, so tenancy is enforced before the core ever runs.

import {
    clockSeconds,
    draftSetWithChase,
    indexByPart,
    indexBySong,
    interleaveBreaks,
    normalizeBreaks,
    seamsFor,
    segmentOrder,
    sequence,
    songsOf,
    type Casting,
    type DraftOptions,
    type DraftWithChase,
    type ID,
    type PaddingProfile,
    type Part,
    type SequenceConfig,
    type SetBreak,
    type Song,
    type VarietyConfig,
} from "@repertoire/core";
import { toDraftInput } from "./mapper.js";
import type {
    ArrangeResponse,
    DraftSetResponse,
    HydrationPayload,
    HydrationSource,
    SeamsResponse,
    SetlistLocks,
    SetlistSource,
} from "./types.js";

/** A present event means the row was found and visible. Null event means 404.
 *  The pool lists must be arrays too: a partial or malformed document (a stray
 *  shape from a broken hydration) is rejected here, not crashed on downstream. */
function isHydrated(raw: unknown): raw is HydrationPayload {
    if (typeof raw !== "object" || raw === null) return false;
    const r = raw as Record<string, unknown>;
    return (
        r.event != null &&
        Array.isArray(r.songs) &&
        Array.isArray(r.parts) &&
        Array.isArray(r.castings) &&
        Array.isArray(r.availability)
    );
}

export async function draftSetForEvent(
    source: HydrationSource,
    eventId: ID,
    config?: SequenceConfig,
    variety?: VarietyConfig,
): Promise<DraftSetResponse> {
    const raw = await source.hydrate(eventId);
    if (!isHydrated(raw)) {
        return {
            status: 404,
            body: { error: "event not found or not visible" },
        };
    }
    const input = toDraftInput(raw);
    const withVariety = variety
        ? { ...input, options: { ...input.options, variety } }
        : input;
    return { status: 200, body: draftSetWithChase(withVariety, config) };
}

/**
 * Re-cost a manual ordering of an event's songs. The drafter re-sequences on
 * every draft, so a director's hand-arrangement needs its seams recomputed
 * without re-drafting. Reads the same pool, resolves the order to known songs
 * (ids the pool does not contain are dropped), and returns the seams plus the
 * padded total. Same seam logic the drafter emits.
 */
export async function seamsForOrder(
    source: HydrationSource,
    eventId: ID,
    order: ID[],
    transitions: { songId: ID; seconds: number }[] = [],
    breaks: SetBreak[] = [],
    config?: SequenceConfig,
): Promise<SeamsResponse> {
    const raw = await source.hydrate(eventId);
    if (!isHydrated(raw)) {
        return {
            status: 404,
            body: { error: "event not found or not visible" },
        };
    }
    const input = toDraftInput(raw);

    const partsBySong = indexBySong(input.parts);
    const castingsByPart = indexByPart(input.castings);

    const songsById = new Map(input.songs.map((s) => [s.id, s]));
    // Dedupe the requested order, first occurrence wins: a duplicated id would
    // self-seam and double-count its time on the clock.
    const ordered: Song[] = [];
    const seen = new Set<ID>();
    for (const id of order) {
        if (seen.has(id)) continue;
        seen.add(id);
        const song = songsById.get(id);
        if (song) ordered.push(song);
    }

    const padding = input.event.padding;
    const transitionOut = new Map(
        transitions.map((t) => [t.songId, t.seconds]),
    );
    // Mirror the draft path's soloist term: the lead seam tracks whoever will actually take a
    // line. The re-cost carries no draft options, so count the confirmed-available only (the
    // conservative default; tentatives are not folded in here).
    const availableMemberIds = new Set(
        input.availability
            .filter((a) => a.status === "in")
            .map((a) => a.memberId),
    );
    const opts = {
        partsBySong,
        castingsByPart,
        perSongGapSeconds: padding.perSongSeconds,
        transitionOut,
        availableMemberIds,
        config,
    };
    // Normalize the breaks against THIS order first, exactly as the draft assembly does
    // (normalizeBreaks in draftSet). Raw breaks would let an out-of-range afterPosition (a break
    // stranded past the current song count) silently drop here while the drafted/published total
    // clamps it in — a clock/segmentation divergence for identical stored data.
    const normBreaks = normalizeBreaks(breaks, ordered.length);
    // Seams are within-segment only — a break is a hard flow-reset, so no seam spans it.
    // Mirrors the draft assembly, which re-sequences each segment independently.
    const seams = segmentOrder(ordered, normBreaks).flatMap((seg) =>
        seamsFor(seg, opts),
    );
    const totalSeconds = clockSeconds(
        ordered,
        padding,
        transitionOut,
        normBreaks,
    );

    return { status: 200, body: { seams, totalSeconds } };
}

/** Coerce the raw locks document, tolerating missing or malformed lists. */
function parseLocks(raw: unknown): SetlistLocks | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const ids = (v: unknown): ID[] =>
        Array.isArray(v) ? v.filter((x): x is ID => typeof x === "string") : [];
    return {
        eventId: typeof r.eventId === "string" ? r.eventId : null,
        opens: ids(r.opens),
        closes: ids(r.closes),
        keep: ids(r.keep),
        excluded: ids(r.excluded),
        transitions: Array.isArray(r.transitions)
            ? r.transitions.flatMap((x): { songId: ID; seconds: number }[] => {
                  if (typeof x !== "object" || x === null) return [];
                  const o = x as { songId?: unknown; seconds?: unknown };
                  return typeof o.songId === "string" &&
                      typeof o.seconds === "number" &&
                      Number.isFinite(o.seconds) &&
                      o.seconds >= 0
                      ? [{ songId: o.songId, seconds: Math.round(o.seconds) }]
                      : [];
              })
            : [],
        breaks: Array.isArray(r.breaks)
            ? r.breaks.flatMap((x): SetBreak[] => {
                  if (typeof x !== "object" || x === null) return [];
                  const o = x as {
                      id?: unknown;
                      label?: unknown;
                      durationSeconds?: unknown;
                      afterPosition?: unknown;
                  };
                  return typeof o.id === "string" &&
                      typeof o.label === "string" &&
                      typeof o.durationSeconds === "number" &&
                      Number.isFinite(o.durationSeconds) &&
                      o.durationSeconds >= 0 &&
                      typeof o.afterPosition === "number" &&
                      Number.isFinite(o.afterPosition) &&
                      o.afterPosition >= 1
                      ? [
                            {
                                id: o.id,
                                label: o.label,
                                durationSeconds: Math.round(o.durationSeconds),
                                afterPosition: Math.round(o.afterPosition),
                            },
                        ]
                      : [];
              })
            : [],
    };
}

/**
 * Override the drafter's order with the director's persisted manual arrangement. The drafter still
 * decides MEMBERSHIP; this only changes ORDER, in place: arranged-order songs still in the set come
 * first (in that order), any newly-selected songs the arrangement predates are appended in the
 * drafter's order, and songs no longer selected drop. Then the seams and clock are re-cost for the
 * exact order (per break segment, same as the arrange/re-cost path), so the editor and the frozen
 * publish/share snapshot both reflect what the director arranged. A no-op when the order is unchanged.
 */
function reorderByArranged(
    body: DraftWithChase,
    arranged: ID[],
    opts: {
        partsBySong: Map<ID, Part[]>;
        castingsByPart: Map<ID, Casting[]>;
        transitionOut: Map<ID, number>;
        availableMemberIds: Set<ID>;
        padding: PaddingProfile;
        rawBreaks: SetBreak[];
        config?: SequenceConfig;
    },
): void {
    const songItems = songsOf(body.set);
    const byId = new Map(songItems.map((it) => [it.song.id, it]));
    const currentIds = songItems.map((it) => it.song.id);
    const inSet = new Set(currentIds);
    const arrangedInSet = arranged.filter((id) => inSet.has(id));
    const placed = new Set(arrangedInSet);
    const finalIds = [
        ...arrangedInSet,
        ...currentIds.filter((id) => !placed.has(id)),
    ];
    if (
        finalIds.length === currentIds.length &&
        finalIds.every((id, i) => id === currentIds[i])
    )
        return;

    const orderedItems = finalIds.map((id) => byId.get(id)!);
    const orderedSongs = orderedItems.map((it) => it.song);
    const breaks = normalizeBreaks(opts.rawBreaks, orderedSongs.length);
    const seamOpts = {
        partsBySong: opts.partsBySong,
        castingsByPart: opts.castingsByPart,
        perSongGapSeconds: opts.padding.perSongSeconds,
        transitionOut: opts.transitionOut,
        availableMemberIds: opts.availableMemberIds,
        config: opts.config,
    };
    body.set = interleaveBreaks(orderedItems, breaks);
    body.seams = segmentOrder(orderedSongs, breaks).flatMap((seg) =>
        seamsFor(seg, seamOpts),
    );
    body.totalSeconds = clockSeconds(
        orderedSongs,
        opts.padding,
        opts.transitionOut,
        breaks,
    );
}

/**
 * POST /setlists/:id/draft-set. Draft into a specific setlist, honoring its
 * pins. Read the locks, then the event's pool, map the pins to the drafter's
 * options, and draft. A null event means the setlist is not found or not
 * visible (404). More than one open or close pin is a setlist the director must
 * fix (422), since the ends take exactly one song each. arrangedOrder, when set, overrides the
 * drafter's order with the director's persisted manual arrangement (reconciled to the drafted set).
 */
export async function draftSetForSetlist(
    source: SetlistSource,
    setlistId: ID,
    config?: SequenceConfig,
    variety?: VarietyConfig,
    prefer?: ID[],
    arrangedOrder?: ID[],
): Promise<DraftSetResponse> {
    const locks = parseLocks(await source.hydrateLocks(setlistId));
    if (!locks || locks.eventId === null) {
        return {
            status: 404,
            body: { error: "setlist not found or not visible" },
        };
    }
    if (locks.opens.length > 1) {
        return {
            status: 422,
            body: { error: "more than one song pinned to open" },
        };
    }
    if (locks.closes.length > 1) {
        return {
            status: 422,
            body: { error: "more than one song pinned to close" },
        };
    }

    const raw = await source.hydrate(locks.eventId);
    if (!isHydrated(raw)) {
        return {
            status: 404,
            body: { error: "event not found or not visible" },
        };
    }

    const base = toDraftInput(raw);
    // prefer carries the gig's prep targets: songs the director committed to are strongly
    // preferred into the set (past the soft gates) but not forced — an uncastable or over-budget
    // commitment benches rather than distorting the set. An explicit exclude still wins: a prep
    // song the director dropped from THIS set stays out.
    const prefers = [
        ...new Set((prefer ?? []).filter((id) => !locks.excluded.includes(id))),
    ];
    const options: DraftOptions = {
        ...base.options,
        open: locks.opens[0],
        close: locks.closes[0],
        keep: locks.keep,
        prefer: prefers,
        excluded: locks.excluded,
        ...(variety ? { variety } : {}),
    };
    const transitionOut = Object.fromEntries(
        locks.transitions.map((t) => [t.songId, t.seconds]),
    );
    const body = draftSetWithChase(
        { ...base, transitionOut, breaks: locks.breaks, options },
        config,
    );
    if (arrangedOrder && arrangedOrder.length) {
        reorderByArranged(body, arrangedOrder, {
            partsBySong: indexBySong(base.parts),
            castingsByPart: indexByPart(base.castings),
            transitionOut: new Map(Object.entries(transitionOut)),
            availableMemberIds: new Set(
                base.availability
                    .filter((a) => a.status === "in")
                    .map((a) => a.memberId),
            ),
            padding: base.event.padding,
            rawBreaks: locks.breaks,
            config,
        });
    }
    return {
        status: 200,
        body,
    };
}

/**
 * Auto-arrange: re-sequence the songs already in a set without re-drafting. A
 * re-draft (draftSetForSetlist) re-runs the funnel and can swap songs in or out;
 * this keeps exactly the songs the caller sends and only re-orders them, honoring
 * the setlist's opener/closer pins. Reads the pins and the pool, resolves the sent
 * order to known songs (ids the pool does not contain are dropped), sequences the
 * interior between the pinned ends, then re-costs the seams within break segments
 * and clocks the total the same way seamsForOrder does — so an arrange and a
 * hand-reorder produce identical seams and totals.
 */
export async function sequenceForOrder(
    source: SetlistSource,
    setlistId: ID,
    order: ID[],
    config?: SequenceConfig,
): Promise<ArrangeResponse> {
    const locks = parseLocks(await source.hydrateLocks(setlistId));
    if (!locks || locks.eventId === null) {
        return {
            status: 404,
            body: { error: "setlist not found or not visible" },
        };
    }
    const raw = await source.hydrate(locks.eventId);
    if (!isHydrated(raw)) {
        return {
            status: 404,
            body: { error: "event not found or not visible" },
        };
    }
    const input = toDraftInput(raw);

    const partsBySong = indexBySong(input.parts);
    const castingsByPart = indexByPart(input.castings);
    const songsById = new Map(input.songs.map((s) => [s.id, s]));

    // Resolve the sent order to known songs, dedupe (first occurrence wins).
    const ordered: Song[] = [];
    const seen = new Set<ID>();
    for (const id of order) {
        if (seen.has(id)) continue;
        seen.add(id);
        const song = songsById.get(id);
        if (song) ordered.push(song);
    }

    const padding = input.event.padding;
    const transitionOut = new Map(
        locks.transitions.map((t) => [t.songId, t.seconds]),
    );
    // Mirror the draft/re-cost soloist term: count confirmed-available only, so the
    // cover who will actually take a line drives the soloist seam.
    const availableMemberIds = new Set(
        input.availability
            .filter((a) => a.status === "in")
            .map((a) => a.memberId),
    );

    // Honor the opener/closer pins; the rest is the interior to re-sequence. A pin not
    // in the current set is ignored, and one song pinned to both ends counts once (open).
    const openSong = locks.opens[0]
        ? ordered.find((s) => s.id === locks.opens[0])
        : undefined;
    const closeId = locks.closes[0];
    const closeSong =
        closeId && closeId !== openSong?.id
            ? ordered.find((s) => s.id === closeId)
            : undefined;
    const pinned = new Set<ID>();
    if (openSong) pinned.add(openSong.id);
    if (closeSong) pinned.add(closeSong.id);
    const middle = ordered.filter((s) => !pinned.has(s.id));

    const arranged = sequence({
        middle,
        open: openSong,
        close: closeSong,
        partsBySong,
        castingsByPart,
        perSongGapSeconds: padding.perSongSeconds,
        transitionOut,
        availableMemberIds,
        config,
    }).order;

    // Seams are within-segment only (a break resets the flow), and the clock counts the
    // break time — the same treatment seamsForOrder gives a hand-arranged order. Normalize the breaks
    // against the arranged length first (as the draft assembly does), so an out-of-range stranded break
    // is clamped in consistently rather than silently dropped here.
    const opts = {
        partsBySong,
        castingsByPart,
        perSongGapSeconds: padding.perSongSeconds,
        transitionOut,
        availableMemberIds,
        config,
    };
    const normBreaks = normalizeBreaks(locks.breaks, arranged.length);
    const seams = segmentOrder(arranged, normBreaks).flatMap((seg) =>
        seamsFor(seg, opts),
    );
    const totalSeconds = clockSeconds(
        arranged,
        padding,
        transitionOut,
        normBreaks,
    );

    return {
        status: 200,
        body: { order: arranged.map((s) => s.id), seams, totalSeconds },
    };
}
