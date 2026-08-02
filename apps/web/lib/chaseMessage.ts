// Turn the chase lever into a call list. computeChase groups by song (who opens
// each); a director chasing people wants the inverse: one entry per person, the
// songs they'd open, and a ready-to-send message. Pure; no core change.

import type { ChaseCandidate } from "@repertoire/core";

export interface CallListEntry {
    memberId: string;
    displayName: string;
    parts: string[]; // the part labels they'd cover
    songs: { title: string; seconds: number }[]; // songs their RSVP would open, with the time each adds, richest first
    totalSeconds: number; // sum of the above; the value of one text, for ranking
    message: string; // a copy-ready text
}

function joinList(items: string[]): string {
    if (items.length <= 1) return items[0] ?? "";
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function chaseCallList(
    chase: ChaseCandidate[],
    eventName = "this set",
): CallListEntry[] {
    // Invert song -> people into person -> songs, carrying the time each song adds. Key the per-person
    // song map by songId, not title: song titles carry no uniqueness, so two distinct chaseable songs
    // that share a title would otherwise collapse to one, undercounting the time and misranking who to
    // call first.
    const byMember = new Map<
        string,
        {
            displayName: string;
            parts: Set<string>;
            songs: Map<string, { title: string; seconds: number }>;
        }
    >();
    for (const c of chase) {
        for (const t of c.chase) {
            const cur = byMember.get(t.memberId) ?? {
                displayName: t.displayName,
                parts: new Set<string>(),
                songs: new Map(),
            };
            cur.parts.add(t.partLabel);
            cur.songs.set(c.songId, {
                title: c.title,
                seconds: c.secondsUnlocked,
            });
            byMember.set(t.memberId, cur);
        }
    }

    const entries: CallListEntry[] = [];
    for (const [memberId, v] of byMember) {
        const songs = [...v.songs.values()].sort(
            (a, b) => b.seconds - a.seconds,
        ); // richest song first within a person
        const totalSeconds = songs.reduce((s, x) => s + x.seconds, 0);
        entries.push({
            memberId,
            displayName: v.displayName,
            parts: [...v.parts],
            songs,
            totalSeconds,
            message: `Hi ${v.displayName}, if you can make ${eventName}, we can add ${joinList(
                songs.map((s) => s.title),
            )}. Can you make it?`,
        });
    }
    // Whoever unlocks the most songs is the most worth a text; break ties on total time.
    return entries.sort(
        (a, b) =>
            b.songs.length - a.songs.length || b.totalSeconds - a.totalSeconds,
    );
}
