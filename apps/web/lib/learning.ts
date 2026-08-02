// The learning tracker: for songs the director has marked 'learning', the covers
// they have not yet assessed as solid (their own read, not the singer's self-report).
// Pure over plain data; no db or framework imports.

import type { Confidence } from "@repertoire/core";

export interface SongAssess {
    song: { id: string; title: string; assessedReadiness: string };
    parts: { id: string; label: string }[];
    castings: {
        partId: string;
        memberId: string;
        directorAssessed: Confidence | null;
    }[];
}

export interface LearningCover {
    memberId: string;
    partId: string;
    displayName: string;
    partLabel: string;
    assessed: Confidence | null; // 'shaky' | 'learning' | null (unassessed); never 'solid'
}

export interface LearningSong {
    songId: string;
    title: string;
    covers: LearningCover[];
}

export function learningTracker(
    songs: SongAssess[],
    nameById: Map<string, string>,
): LearningSong[] {
    const out: LearningSong[] = [];
    for (const s of songs) {
        if (s.song.assessedReadiness !== "learning") continue;
        const labelByPart = new Map(s.parts.map((p) => [p.id, p.label]));
        const covers: LearningCover[] = s.castings
            .filter((c) => c.directorAssessed !== "solid") // not yet confirmed solid
            .map((c) => ({
                memberId: c.memberId,
                partId: c.partId,
                displayName: nameById.get(c.memberId) ?? c.memberId,
                partLabel: labelByPart.get(c.partId) ?? "part",
                assessed: c.directorAssessed,
            }));
        if (covers.length > 0)
            out.push({ songId: s.song.id, title: s.song.title, covers });
    }
    return out;
}
