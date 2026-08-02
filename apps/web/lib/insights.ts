// Coverage analytics for the director: bus-factor and what-if. Both are thin
// orchestration over core's feasibility matcher, run against different available
// sets. Pure functions over plain data, no db or framework imports, so the
// server page and the client what-if panel can both call them.
//
// Coverage is read from castings only (who is cast), matching the drafter's own
// model. Range and voice-part membership are deliberately not consulted here.

import { checkFeasibility, indexBySong, indexByPart } from "@repertoire/core";
import type { Casting, ID, Part, Song } from "@repertoire/core";

export interface SongCoverage {
    song: Song;
    parts: Part[];
    castings: Casting[];
}

export interface PoolMember {
    id: ID;
    displayName: string;
}

// Regroup the flat songs/parts/castings arrays a hydration payload carries into
// per-song coverage. Used by the what-if page; the bus-factor page builds
// coverage straight from the per-song db reads.
export function toCoverage(
    songs: Song[],
    parts: Part[],
    castings: Casting[],
): SongCoverage[] {
    const partsBySong = indexBySong(parts);
    const songByPart = new Map<ID, ID>(parts.map((p) => [p.id, p.songId]));
    const castsBySong = new Map<ID, Casting[]>();
    for (const c of castings) {
        const songId = songByPart.get(c.partId);
        if (songId === undefined) continue;
        const arr = castsBySong.get(songId);
        if (arr) arr.push(c);
        else castsBySong.set(songId, [c]);
    }
    return songs.map((song) => ({
        song,
        parts: partsBySong.get(song.id) ?? [],
        castings: castsBySong.get(song.id) ?? [],
    }));
}

// --- Bus factor -----------------------------------------------------------
//
// Single points of failure across the whole repertoire. A song is fragile when
// removing one member from the full pool makes it infeasible. Removing-and-
// rechecking (rather than counting covers per part) is what catches the case a
// headcount misses: one member who covers two parts can be load-bearing even
// where each of those parts has a backup, because one singer fills one line.

export type BusFactorKind = "undercast" | "single-point";

export interface CriticalMember {
    memberId: ID;
    displayName: string;
    parts: string[]; // part labels that go uncovered without this member
}

export interface BusFactorRow {
    songId: ID;
    title: string;
    kind: BusFactorKind;
    shortParts: { label: string; needed: number; covered: number }[]; // undercast
    critical: CriticalMember[]; // single-point
}

export function busFactor(
    coverage: SongCoverage[],
    pool: PoolMember[],
): BusFactorRow[] {
    const fullPool = new Set(pool.map((m) => m.id));
    const nameById = new Map<ID, string>(
        pool.map((m) => [m.id, m.displayName]),
    );
    const rows: BusFactorRow[] = [];

    for (const { song, parts, castings } of coverage) {
        const byPart = indexByPart(castings);
        const songIndex = { song, parts };
        const full = checkFeasibility({
            songIndex,
            castingsByPart: byPart,
            availableMemberIds: fullPool,
        });

        // Can't be cast even with everyone present: the most severe risk.
        if (!full.feasible) {
            rows.push({
                songId: song.id,
                title: song.title,
                kind: "undercast",
                shortParts: full.shortParts,
                critical: [],
            });
            continue;
        }

        // Pull each cast member and see if the song falls apart without them.
        const castInPool = [...new Set(castings.map((c) => c.memberId))].filter(
            (id) => fullPool.has(id),
        );
        const critical: CriticalMember[] = [];
        for (const memberId of castInPool) {
            const without = new Set(fullPool);
            without.delete(memberId);
            const r = checkFeasibility({
                songIndex,
                castingsByPart: byPart,
                availableMemberIds: without,
            });
            if (!r.feasible) {
                critical.push({
                    memberId,
                    displayName: nameById.get(memberId) ?? memberId,
                    parts: r.shortParts.map((s) => s.label),
                });
            }
        }
        if (critical.length > 0) {
            rows.push({
                songId: song.id,
                title: song.title,
                kind: "single-point",
                shortParts: [],
                critical,
            });
        }
    }

    // Worst first: undercast (uncastable now) before single-point (fragile).
    const rank = (k: BusFactorKind): number => (k === "undercast" ? 0 : 1);
    return rows.sort((a, b) => rank(a.kind) - rank(b.kind));
}

// --- What-if availability -------------------------------------------------
//
// Recompute coverage for an event under a simulated available set, and diff it
// against the saved baseline. "Available" means RSVP 'in', matching the drafter
// (tentative does not count by default).

export interface WhatIfRow {
    songId: ID;
    title: string;
    feasible: boolean;
}

export interface WhatIfResult {
    rows: WhatIfRow[];
    coverableCount: number;
    broke: WhatIfRow[]; // feasible at baseline, not under the simulation
    unlocked: WhatIfRow[]; // infeasible at baseline, feasible under the simulation
}

export function whatIf(
    coverage: SongCoverage[],
    availableNow: Set<ID>,
    baselineAvailable: Set<ID>,
): WhatIfResult {
    const rows: WhatIfRow[] = [];
    const broke: WhatIfRow[] = [];
    const unlocked: WhatIfRow[] = [];
    let coverableCount = 0;

    for (const { song, parts, castings } of coverage) {
        const byPart = indexByPart(castings);
        const songIndex = { song, parts };
        const now = checkFeasibility({
            songIndex,
            castingsByPart: byPart,
            availableMemberIds: availableNow,
        }).feasible;
        const base = checkFeasibility({
            songIndex,
            castingsByPart: byPart,
            availableMemberIds: baselineAvailable,
        }).feasible;
        const row: WhatIfRow = {
            songId: song.id,
            title: song.title,
            feasible: now,
        };
        rows.push(row);
        if (now) coverableCount++;
        if (base && !now) broke.push(row);
        if (!base && now) unlocked.push(row);
    }

    return { rows, coverableCount, broke, unlocked };
}
