// Build per-song coverage (parts + castings) for a set of songs from ONE batched read, replacing the
// per-song getSongParts + getSongCasting fan-out that made the dashboard, insights, rehearsal-agenda,
// and playground pages issue ~3 queries per active song (the N+1). It fetches the whole book's parts
// and castings once (repo.getEnsembleCoverage) and regroups them in memory, exactly as the per-song
// reads would have grouped, so behaviour is unchanged.
//
// Generic in the song type so a caller that needs extra SongRow fields (e.g. assessedReadiness for the
// learning tracker) keeps them. The result is assignable to insights' SongCoverage for busFactor /
// whatIf, because MockPart / MockCasting are structurally Part / Casting.

import type { Repository } from "./repository";
import type { MockCasting, MockPart } from "./db";

export interface Coverage<S> {
    song: S;
    parts: MockPart[];
    castings: MockCasting[];
}

export async function buildCoverage<S extends { id: string }>(
    repo: Repository,
    songs: S[],
): Promise<Coverage<S>[]> {
    const { parts, castings } = await repo.getEnsembleCoverage();

    const partsBySong = new Map<string, MockPart[]>();
    const songByPart = new Map<string, string>();
    for (const p of parts) {
        songByPart.set(p.id, p.songId);
        const list = partsBySong.get(p.songId);
        if (list) list.push(p);
        else partsBySong.set(p.songId, [p]);
    }

    const castsBySong = new Map<string, MockCasting[]>();
    for (const c of castings) {
        const songId = songByPart.get(c.partId);
        if (songId === undefined) continue; // a casting whose part is outside the book — drop it, as the per-song read would
        const list = castsBySong.get(songId);
        if (list) list.push(c);
        else castsBySong.set(songId, [c]);
    }

    return songs.map((song) => ({
        song,
        parts: partsBySong.get(song.id) ?? [],
        castings: castsBySong.get(song.id) ?? [],
    }));
}
