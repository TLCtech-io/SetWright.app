// Stage 4a: selection.
//
// Fill to the target length, biased under, because running long is worse than
// running short. This is a greedy fill by score, not a knapsack optimiser:
// the spec wants a strong starting point, and the director finishes by hand.

import type { ID, PaddingProfile, SetBreak, Song } from "../types.js";

/**
 * Chart length plus the event's per-song padding, in seconds. Padding is a flat
 * per-song add. Returns null when the chart has no duration, since such a song
 * cannot be length-placed. This is the fill-budget estimate per song; the displayed
 * running-order time is the clock (clockSeconds).
 */
export function stageTime(song: Song, padding: PaddingProfile): number | null {
    if (song.durationSeconds === null) return null;
    return Math.round(song.durationSeconds + padding.perSongSeconds);
}

/**
 * The true running-order clock, in seconds: every song's duration, plus the gap
 * BETWEEN adjacent songs (a per-song transition override if set, else the event's
 * per-song padding — never charged after the last song), plus the one-time per-set
 * overhead. This is what the director reads off the wall — distinct from summing the
 * per-song `stage`, which double-counts a gap after the last song and omits the
 * per-set overhead.
 */
export function clockSeconds(
    songs: Song[],
    padding: PaddingProfile,
    transitionOut: Map<ID, number>,
    breaks: SetBreak[] = [],
): number {
    // A break at a boundary REPLACES the inter-song gap there with its own duration
    // (the intermission is the transition time). afterPosition k = the gap after the
    // k-th song; positions out of [1, n-1] never match a boundary and are ignored. At most
    // one break per slot (first wins), matching normalizeBreaks/interleaveBreaks, so a
    // duplicate-position break is not double-counted.
    const breakAt = new Map<number, number>();
    for (const b of breaks)
        if (!breakAt.has(b.afterPosition))
            breakAt.set(b.afterPosition, b.durationSeconds);
    let total = padding.perSetSeconds;
    songs.forEach((s, i) => {
        total += Math.round(s.durationSeconds ?? 0);
        if (i < songs.length - 1) {
            const brk = breakAt.get(i + 1);
            total +=
                brk !== undefined
                    ? brk
                    : (transitionOut.get(s.id) ?? padding.perSongSeconds);
        }
    });
    return total;
}

/**
 * Cut a song order into segments at the break ordinals (afterPosition = the gap
 * after the k-th song). Breaks out of range (not between two songs) are ignored;
 * duplicate positions collapse to one cut. No breaks => one segment (the whole
 * order). Each segment is sequenced independently — a break is a hard flow-reset.
 */
export function segmentOrder(order: Song[], breaks: SetBreak[]): Song[][] {
    const cuts = [
        ...new Set(
            breaks
                .map((b) => b.afterPosition)
                .filter((p) => p >= 1 && p < order.length),
        ),
    ].sort((a, b) => a - b);
    const segments: Song[][] = [];
    let start = 0;
    for (const c of cuts) {
        segments.push(order.slice(start, c));
        start = c;
    }
    segments.push(order.slice(start));
    return segments;
}

export interface Scored {
    song: Song;
    stage: number; // padded seconds
    score: number; // higher is better
    prefer?: boolean; // a prep commitment: filled before non-preferred songs, still budget-gated
}

/**
 * Score-descending with a song-id tie-break. The hydration arrays carry no
 * ORDER BY, so a plain score sort breaks ties by physical row order and two
 * identical drafts can select, bench, and sequence differently. Every score
 * sort in the drafter goes through this so the output is independent of input
 * array order.
 */
export function byScoreThenId(a: Scored, b: Scored): number {
    if (a.score !== b.score) return b.score - a.score;
    return a.song.id < b.song.id ? -1 : a.song.id > b.song.id ? 1 : 0;
}

/**
 * Selection order: preferred (prep) songs first as a tier, then score-descending. A tier,
 * not a score bump, so a preferred song always outranks a non-preferred one no matter how
 * their scores compare. Within each tier byScoreThenId keeps the order deterministic, so a
 * tight budget benches the least-ready prep, not an arbitrary one.
 */
export function byPreferThenScore(a: Scored, b: Scored): number {
    if (!!a.prefer !== !!b.prefer) return a.prefer ? -1 : 1;
    return byScoreThenId(a, b);
}

export interface FillBudget {
    targetSeconds: number; // Infinity for no target
    perSetSeconds: number;
    breakSeconds: number; // reserved requested-break time, off the top
    perSongGapSeconds: number; // the uniform inter-song gap, the default when no override
    transitionOut: Map<ID, number>; // per-from-song gap overrides (segues)
}

/**
 * Add songs by descending score while the set still fits the target on the AUTHORITATIVE clock,
 * not a per-song estimate. The clock charges k-1 inter-song gaps (none trails the last song), each
 * the song's transition override if set, else the uniform padding, plus the per-set overhead and
 * reserved break time. We don't know the final order here, so admit a song when the set fits in its
 * BEST order — the one that drops the LARGEST gap (the sequencer naturally places a long-segue song
 * where its gap matters least, last/at a boundary). Drop the largest gap, not the smallest: it is
 * the tight lower bound on the achievable clock, so it admits exactly the songs that fit in some
 * order. A smallest-gap estimate would be overrun-safe but loose: once a long segue is committed it
 * over-counts every later candidate by (long gap − smallest gap), stranding fitting songs and
 * firing a false shortfall. The caller trims the produced order against the real clock to keep the
 * no-overrun guarantee. With uniform gaps best == worst, so the common no-segue case never needs
 * the trim. `forced` songs (open, close, keep) are pinned in and counted first.
 */
export function selectToLength(
    pool: Scored[],
    budget: FillBudget,
    forced: Scored[] = [],
): { chosen: Scored[]; usedSeconds: number } {
    const gapOf = (s: Scored): number =>
        budget.transitionOut.get(s.song.id) ?? budget.perSongGapSeconds;
    const durOf = (s: Scored): number =>
        Math.round(s.song.durationSeconds ?? 0);
    const cap =
        budget.targetSeconds - budget.perSetSeconds - budget.breakSeconds;

    // Running best-case clock estimate of the selected set: Σ durations + (Σ gaps − the largest gap).
    let count = 0;
    let dur = 0;
    let gapSum = 0;
    let gapMax = -Infinity;
    const commit = (s: Scored): void => {
        count += 1;
        dur += durOf(s);
        const g = gapOf(s);
        gapSum += g;
        if (g > gapMax) gapMax = g;
    };

    for (const f of forced) commit(f); // pins go in regardless, but count toward the clock

    const chosen: Scored[] = [];
    // Preferred (prep) songs first, then by score. They are budget-gated like any candidate —
    // filled ahead of the rest, and the overflow benches rather than forcing the set over.
    const sorted = [...pool].sort(byPreferThenScore);
    for (const item of sorted) {
        const g = gapOf(item);
        const newCount = count + 1;
        const est =
            dur +
            durOf(item) +
            (newCount >= 2 ? gapSum + g - Math.max(gapMax, g) : 0);
        if (est <= cap) {
            commit(item);
            chosen.push(item);
        }
    }

    const usedSeconds = dur + (count >= 2 ? gapSum - gapMax : 0);
    return { chosen, usedSeconds };
}
