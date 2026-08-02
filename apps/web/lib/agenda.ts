// The rehearsal agenda ranker: turn the four "what needs the work" signals into one
// ordered list of suggestions, each carrying the reasons it surfaced. Pure over plain
// data; no db or framework imports, so the rehearsal page computes the signals from the
// repository and this ranks them.
//
// The signals themselves are reused as-is: busFactor (coverage risk) and learningTracker
// (unassessed covers) from lib/insights + lib/learning, plus staleness (last_rehearsed
// gone cold) and upcoming-gig prefer, both derived on the page. This module does not
// re-run feasibility; it only ranks and labels.

import type { BusFactorRow } from "./insights";
import type { LearningSong } from "./learning";

export type AgendaReasonKind =
    | "coverage-risk"
    | "learning-gap"
    | "stale"
    | "upcoming-gig";

export interface AgendaReason {
    kind: AgendaReasonKind;
    detail: string; // short chip text, e.g. "Only Ana covers Bass"
}

export interface AgendaSuggestion {
    songId: string;
    title: string;
    reasons: AgendaReason[]; // ordered most-urgent first
}

// A song gone cold: performance-ready but not rehearsed in the staleness window.
export interface StaleSong {
    songId: string;
    title: string;
    days: number; // days since last rehearsed
}

// A song an upcoming gig prefers (its tags intersect the gig's prefer tags).
export interface UpcomingPreferSong {
    songId: string;
    title: string;
    eventNames: string[]; // the upcoming gigs that prefer it, soonest first
}

export interface AgendaSignals {
    coverageRisk: BusFactorRow[]; // from busFactor()
    learning: LearningSong[]; // from learningTracker()
    stale: StaleSong[];
    upcoming: UpcomingPreferSong[];
}

// Priority of each reason kind: lower is more urgent, and sets the primary sort. Coverage
// risk (a part that can't be covered) is the most time-worthy thing to rehearse; a song
// merely wanted for an upcoming gig is the least. A song can carry several reasons.
const PRIORITY: Record<AgendaReasonKind, number> = {
    "coverage-risk": 0,
    "learning-gap": 1,
    stale: 2,
    "upcoming-gig": 3,
};

function coverageDetail(row: BusFactorRow): string {
    if (row.kind === "undercast") {
        const labels = row.shortParts.map((p) => p.label);
        return labels.length > 0
            ? `Undercast: ${labels.join(", ")} short`
            : "Undercast now";
    }
    // single-point: name who, when it is just one person, else count the fragile spots.
    if (row.critical.length === 1) {
        const c = row.critical[0]!;
        const parts = c.parts.length > 0 ? ` ${c.parts.join(", ")}` : "";
        return `Only ${c.displayName} covers${parts}`;
    }
    return `${row.critical.length} single points of failure`;
}

function upcomingDetail(row: UpcomingPreferSong): string {
    const [first, ...rest] = row.eventNames;
    if (!first) return "Wanted for an upcoming gig";
    return rest.length > 0 ? `For ${first} +${rest.length}` : `For ${first}`;
}

// Merge the four signals into one suggestion per song, reasons ordered by priority, then
// rank: most-urgent reason first, then the song hitting more signals, then title for a
// stable order. Every signal already scopes itself to active songs, so no filtering here.
export function suggestAgenda(signals: AgendaSignals): AgendaSuggestion[] {
    const bySong = new Map<string, AgendaSuggestion>();
    const add = (songId: string, title: string, reason: AgendaReason): void => {
        const existing = bySong.get(songId);
        if (existing) existing.reasons.push(reason);
        else bySong.set(songId, { songId, title, reasons: [reason] });
    };

    for (const row of signals.coverageRisk) {
        add(row.songId, row.title, {
            kind: "coverage-risk",
            detail: coverageDetail(row),
        });
    }
    for (const song of signals.learning) {
        const n = song.covers.length;
        add(song.songId, song.title, {
            kind: "learning-gap",
            detail: `${n} cover${n === 1 ? "" : "s"} unassessed`,
        });
    }
    for (const s of signals.stale) {
        add(s.songId, s.title, {
            kind: "stale",
            detail: `Not rehearsed in ${s.days} days`,
        });
    }
    for (const u of signals.upcoming) {
        add(u.songId, u.title, {
            kind: "upcoming-gig",
            detail: upcomingDetail(u),
        });
    }

    const suggestions = [...bySong.values()];
    for (const s of suggestions) {
        s.reasons.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
    }
    suggestions.sort((a, b) => {
        const topA = PRIORITY[a.reasons[0]!.kind];
        const topB = PRIORITY[b.reasons[0]!.kind];
        if (topA !== topB) return topA - topB;
        if (a.reasons.length !== b.reasons.length)
            return b.reasons.length - a.reasons.length;
        return a.title.localeCompare(b.title);
    });
    return suggestions;
}
