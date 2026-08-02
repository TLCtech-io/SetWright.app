// Rehearsal-planner deadlines. A prep target is a commitment to have a song ready for
// a gig, and the gig's date is the deadline. "Behind schedule" is the derived view: a
// targeted song that is not performance-ready or not fully cast, with an upcoming gig
// bearing down. The pure ranker is testable in isolation; the async builders gather the
// repo reads (readiness, casting feasibility, dates) the two surfaces need.

import type { AssessedReadiness } from "@repertoire/core";
import { busFactor } from "./insights";
import { buildCoverage } from "./coverage";
import type { Repository } from "./repository";
import type { EventRow, SongRow } from "./db";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
    Math.round((Date.parse(b) - Date.parse(a)) / DAY);

// A gig with a known future date and the songs it wants ready.
export interface BehindGig {
    id: string;
    name: string;
    date: string; // ISO date, already known to be >= today
    targetSongIds: string[];
}

export interface BehindInput {
    gigs: BehindGig[];
    titleById: Map<string, string>;
    notReady: Set<string>; // song ids whose readiness is not performance-ready
    undercast: Set<string>; // song ids infeasible with the full pool (can't be fully cast)
    today: string; // ISO date in the ensemble timezone
}

export interface BehindRow {
    songId: string;
    title: string;
    gigId: string;
    gigName: string;
    deadline: string; // the gig's date
    daysLeft: number; // today -> deadline, never negative (gigs are pre-filtered to the future)
    notReady: boolean; // not performance-ready
    undercast: boolean; // can't be fully cast with everyone present
}

// One row per behind song, bound to its SOONEST at-risk target gig (the binding deadline).
// Readiness is per song, not per gig, so a not-ready song is behind for its nearest target;
// dedupe on first hit after sorting gigs by date. Ranked by urgency (days left), then title.
export function behindSchedule(input: BehindInput): BehindRow[] {
    const gigs = [...input.gigs].sort((a, b) => a.date.localeCompare(b.date));
    const seen = new Set<string>();
    const rows: BehindRow[] = [];
    for (const gig of gigs) {
        for (const songId of gig.targetSongIds) {
            if (seen.has(songId)) continue;
            const notReady = input.notReady.has(songId);
            const undercast = input.undercast.has(songId);
            if (!notReady && !undercast) continue; // on track for this gig
            seen.add(songId);
            rows.push({
                songId,
                title: input.titleById.get(songId) ?? songId,
                gigId: gig.id,
                gigName: gig.name,
                deadline: gig.date,
                daysLeft: Math.max(0, daysBetween(input.today, gig.date)),
                notReady,
                undercast,
            });
        }
    }
    rows.sort(
        (a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title),
    );
    return rows;
}

// Build the not-ready and undercast sets from the active book. Shared by the gatherer and
// the per-gig view so both judge "ready" the same way: performance-ready AND fully cast.
async function readinessSignals(
    repo: Repository,
    active: SongRow[],
): Promise<{ notReady: Set<string>; undercast: Set<string> }> {
    const members = await repo.listMembers(); // active singing pool: the coverage pool
    const coverage = await buildCoverage(repo, active); // one batched read, not a query per song
    const notReady = new Set(
        active
            .filter((s) => s.assessedReadiness !== "performance-ready")
            .map((s) => s.id),
    );
    const undercast = new Set(
        busFactor(coverage, members)
            .filter((r) => r.kind === "undercast")
            .map((r) => r.songId),
    );
    return { notReady, undercast };
}

// The whole "behind schedule" list, across every upcoming gig. listEvents is fail-closed to
// gigs, so rehearsals never count as their own deadline. Used by the insights page and
// (via its own inputs) the dashboard.
export async function gatherBehindSchedule(
    repo: Repository,
    today: string,
): Promise<BehindRow[]> {
    const allSongs = await repo.listSongs();
    const active = allSongs.filter((s) => s.status === "active");
    const titleById = new Map(active.map((s) => [s.id, s.title]));
    const { notReady, undercast } = await readinessSignals(repo, active);

    const upcoming = (await repo.listEvents()).filter(
        (e) => !!e.resolved.eventDate && e.resolved.eventDate >= today,
    );
    const gigs: BehindGig[] = await Promise.all(
        upcoming.map(async (e) => ({
            id: e.id,
            name: e.name,
            date: e.resolved.eventDate!,
            targetSongIds: await repo.getPrepTargets(e.id),
        })),
    );
    return behindSchedule({
        gigs: gigs.filter((g) => g.targetSongIds.length > 0),
        titleById,
        notReady,
        undercast,
        today,
    });
}

// The per-gig prep view for the event page. Every active song carries its ready status, so
// the panel can show status live for a song the moment it is added (not just saved targets),
// and targetIds is the saved set. Ready = performance-ready AND fully cast.
export interface PrepSong {
    id: string;
    title: string;
    readiness: AssessedReadiness; // for the picker's readiness sort
    lastRehearsed: string | null;
    durationSeconds: number | null;
    tags: string[]; // tag names, for the picker's search + chip filter
    notReady: boolean;
    undercast: boolean;
}
export interface PrepView {
    targetIds: string[];
    songs: PrepSong[];
}

export async function buildPrepView(
    repo: Repository,
    event: EventRow,
): Promise<PrepView> {
    const allSongs = await repo.listSongs();
    const active = allSongs.filter((s) => s.status === "active");
    const known = new Set(active.map((s) => s.id));
    const { notReady, undercast } = await readinessSignals(repo, active);

    const songs: PrepSong[] = active.map((s) => ({
        id: s.id,
        title: s.title,
        readiness: s.assessedReadiness,
        lastRehearsed: s.lastRehearsed,
        durationSeconds: s.durationSeconds,
        tags: s.tags.map((t) => t.name),
        notReady: notReady.has(s.id),
        undercast: undercast.has(s.id),
    }));
    const targetIds = (await repo.getPrepTargets(event.id)).filter((id) =>
        known.has(id),
    );
    return { targetIds, songs };
}
