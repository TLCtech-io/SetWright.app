// Assemble everything the rehearsal agenda panel needs, server-side. This is the
// repo-coupled half of the agenda planner: it runs the four "what to run" signals over the active book
// and ranks them (suggestAgenda), reads the saved agenda, and computes a "given who is
// coming" feasibility flag per song from the rehearsal's 'in' RSVPs. The ranking itself
// stays pure in lib/agenda; this only gathers and hands off.

import {
    checkFeasibility,
    indexByPart,
    type AssessedReadiness,
} from "@repertoire/core";
import type { Repository } from "./repository";
import type { EventRow } from "./db";
import { busFactor } from "./insights";
import { buildCoverage } from "./coverage";
import { learningTracker, type SongAssess } from "./learning";
import {
    suggestAgenda,
    type AgendaReason,
    type StaleSong,
    type UpcomingPreferSong,
} from "./agenda";
import { todayInTz } from "./format";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
    Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const STALE_DAYS = 90; // matches the dashboard's "gone cold" window

// Whether a song can be fully run given who is coming. 'unknown' when no one is 'in' yet,
// so the flag stays silent rather than claiming everything is short.
export interface AgendaRun {
    run: "full" | "short" | "unknown";
    shortParts: string[]; // labels that go uncovered given who is in
}

// One row per active song, everything the unified picker sorts, filters, and badges on.
// Suggested songs carry their ranked reasons and a rank (0 = most needed); the rest of the
// book carries an empty reason list and a null rank, so the whole book lives in one list.
export interface AgendaSongRow {
    id: string;
    title: string;
    readiness: AssessedReadiness;
    lastRehearsed: string | null;
    durationSeconds: number | null;
    tags: string[];
    reasons: AgendaReason[]; // ranked suggestion reasons; empty when the song did not surface
    rank: number | null; // position in the ranking (0 = most needed); null when not suggested
    prepGigs: string[]; // upcoming gigs whose prep-target list names this song (the "songs for the show" filter)
    run: AgendaRun; // can it be fully run given who is 'in'
}

export interface RehearsalAgendaView {
    saved: { songId: string; reason: string | null; note: string | null }[];
    songs: AgendaSongRow[]; // the whole active book, enriched — the picker filters and ranks it
    upcomingGigs: string[]; // distinct upcoming-gig names, for the picker's gig filter
    inCount: number; // singers RSVP'd 'in', for the "given N coming" caption
}

export async function buildRehearsalAgendaView(
    repo: Repository,
    event: EventRow,
): Promise<RehearsalAgendaView> {
    const [allSongs, roster, settings, savedItems] = await Promise.all([
        repo.listSongs(),
        repo.listRoster(),
        repo.getEnsembleSettings(),
        repo.getRehearsalAgenda(event.id),
    ]);
    const active = allSongs.filter((s) => s.status === "active");
    const coverage = await buildCoverage(repo, active); // one batched read, not a query per song
    const pool = roster
        .filter((m) => m.singing && m.status === "active")
        .map((m) => ({ id: m.id, displayName: m.displayName }));

    // Signal 1: coverage risk (fragile / undercast songs).
    const coverageRisk = busFactor(coverage, pool);

    // Signal 2: learning gaps (unassessed covers on learning songs).
    const nameById = new Map(roster.map((m) => [m.id, m.displayName]));
    const assess: SongAssess[] = coverage.map(({ song, parts, castings }) => ({
        song: {
            id: song.id,
            title: song.title,
            assessedReadiness: song.assessedReadiness,
        },
        parts: parts.map((p) => ({ id: p.id, label: p.label ?? "part" })),
        castings: castings.map((c) => ({
            partId: c.partId,
            memberId: c.memberId,
            directorAssessed: c.directorAssessed,
        })),
    }));
    const learning = learningTracker(assess, nameById);

    // Signal 3: staleness (performance-ready but gone cold on rehearsal).
    const today = todayInTz(settings.timezone);
    const stale: StaleSong[] = active
        .filter(
            (s) =>
                s.assessedReadiness === "performance-ready" &&
                !!s.lastRehearsed &&
                daysBetween(s.lastRehearsed, today) > STALE_DAYS,
        )
        .map((s) => ({
            songId: s.id,
            title: s.title,
            days: daysBetween(s.lastRehearsed!, today),
        }));

    // Upcoming gigs (future-dated), read once. listEvents is fail-closed to gigs, so a rehearsal
    // never counts as its own deadline.
    const futureGigs = (await repo.listEvents({ kind: "gig" }))
        .filter((e) => !!e.resolved.eventDate && e.resolved.eventDate >= today)
        .sort((a, b) =>
            a.resolved.eventDate!.localeCompare(b.resolved.eventDate!),
        );

    // Signal 4 (suggestion): songs an upcoming gig prefers (song tags intersect the gig's prefer tags).
    const upcomingGigs = futureGigs.filter((e) => e.preferTags.length > 0);
    const upcoming: UpcomingPreferSong[] = active
        .map((s) => {
            const tagNames = new Set(s.tags.map((t) => t.name));
            const eventNames = upcomingGigs
                .filter((g) => g.preferTags.some((t) => tagNames.has(t)))
                .map((g) => g.name);
            return { songId: s.id, title: s.title, eventNames };
        })
        .filter((u) => u.eventNames.length > 0);

    // The picker's "songs for the show" filter runs off concrete prep targets, not the tag
    // heuristic above. A draft setlist has no stored order, so each gig's prep-targets list is the
    // persisted "songs to have ready" for it. Read every upcoming gig's prep targets; only gigs
    // that have set any become filter options, keyed to the songs they name.
    const gigPrep = (
        await Promise.all(
            futureGigs.map(async (g) => ({
                name: g.name,
                songIds: new Set(await repo.getPrepTargets(g.id)),
            })),
        )
    ).filter((g) => g.songIds.size > 0);
    const prepGigsBySong = new Map<string, string[]>();
    for (const g of gigPrep) {
        for (const id of g.songIds)
            prepGigsBySong.set(id, [...(prepGigsBySong.get(id) ?? []), g.name]);
    }

    const ranked = suggestAgenda({ coverageRisk, learning, stale, upcoming });

    // Who's-coming feasibility: 'in' RSVPs among the active pool, per song.
    const poolIds = new Set(pool.map((m) => m.id));
    const inSet = new Set(
        event.availability
            .filter((a) => a.status === "in" && poolIds.has(a.memberId))
            .map((a) => a.memberId),
    );
    const inCount = inSet.size;
    const runBySong: Record<string, AgendaRun> = {};
    for (const { song, parts, castings } of coverage) {
        if (inCount === 0) {
            runBySong[song.id] = { run: "unknown", shortParts: [] };
            continue;
        }
        const r = checkFeasibility({
            songIndex: { song, parts },
            castingsByPart: indexByPart(castings),
            availableMemberIds: inSet,
        });
        runBySong[song.id] = r.feasible
            ? { run: "full", shortParts: [] }
            : { run: "short", shortParts: r.shortParts.map((p) => p.label) };
    }

    // Fold the ranking back onto every active song: a suggested song keeps its reasons + rank,
    // the rest of the book gets an empty list + null rank. One list, so the picker holds the
    // whole book with the suggestions floated to the top under "Most needed".
    const rankBySong = new Map(
        ranked.map((s, i) => [s.songId, { reasons: s.reasons, rank: i }]),
    );
    const songs: AgendaSongRow[] = active.map((s) => {
        const sug = rankBySong.get(s.id);
        return {
            id: s.id,
            title: s.title,
            readiness: s.assessedReadiness,
            lastRehearsed: s.lastRehearsed,
            durationSeconds: s.durationSeconds,
            tags: s.tags.map((t) => t.name),
            reasons: sug?.reasons ?? [],
            rank: sug?.rank ?? null,
            prepGigs: prepGigsBySong.get(s.id) ?? [],
            run: runBySong[s.id] ?? { run: "unknown", shortParts: [] },
        };
    });

    return {
        saved: savedItems.map((i) => ({
            songId: i.songId,
            reason: i.reason,
            note: i.note,
        })),
        songs,
        upcomingGigs: gigPrep.map((g) => g.name),
        inCount,
    };
}

// Rehearsal record panel: the saved agenda songs to mark rehearsed (with their current
// last_rehearsed so the director sees what advances), the singers to record attendance for
// (defaulted from their RSVP), and the rehearsal date. Read independently of the agenda
// view so recording never entangles with editing the plan.
export interface RehearsalRecordView {
    date: string; // the rehearsal's event date, else the ensemble-tz today (resolved server-side)
    songs: { songId: string; title: string; lastRehearsed: string | null }[]; // the saved agenda, in order
    members: {
        id: string;
        displayName: string;
        rsvp: "in" | "out" | "tentative" | null;
        present: boolean | null; // recorded attendance if any; null = not recorded (client defaults from rsvp)
    }[];
    recorded: boolean; // whether attendance has been recorded for this rehearsal yet
}

// `today` is the ensemble-tz current date (todayInTz), the fallback for a date-TBD rehearsal.
// Resolved here, server-side, so the record is stamped in the ensemble's day, not the browser's UTC.
export async function buildRehearsalRecordView(
    repo: Repository,
    event: EventRow,
    today: string,
): Promise<RehearsalRecordView> {
    const [savedItems, allSongs, roster, attendance] = await Promise.all([
        repo.getRehearsalAgenda(event.id),
        repo.listSongs(),
        repo.listRoster(),
        repo.getAttendance(event.id),
    ]);
    const songById = new Map(allSongs.map((s) => [s.id, s]));
    const songs = savedItems
        .map((i) => songById.get(i.songId))
        .filter((s): s is NonNullable<typeof s> => !!s && s.status === "active")
        .map((s) => ({
            songId: s.id,
            title: s.title,
            lastRehearsed: s.lastRehearsed,
        }));

    const rsvpByMember = new Map(
        event.availability.map((a) => [a.memberId, a.status]),
    );
    const presentByMember = new Map(
        attendance.map((a) => [a.memberId, a.present]),
    );
    const activeMembers = roster.filter(
        (m) => m.singing && m.status === "active",
    );
    const activeIds = new Set(activeMembers.map((m) => m.id));
    // Carry any already-recorded member who has since left the active pool. Save is a full
    // replace-write, so dropping them from the panel would delete their attendance row on the
    // next save and erase a durable "who showed" fact. They only appear once recorded.
    const carried = roster.filter(
        (m) => !activeIds.has(m.id) && presentByMember.has(m.id),
    );
    const members = [...activeMembers, ...carried].map((m) => ({
        id: m.id,
        displayName: m.displayName,
        rsvp: rsvpByMember.get(m.id) ?? null,
        present: presentByMember.has(m.id) ? presentByMember.get(m.id)! : null,
    }));

    return {
        date: event.resolved.eventDate ?? today,
        songs,
        members,
        recorded: attendance.length > 0,
    };
}
