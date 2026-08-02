// The one-liner every /api/e/:ensembleId route handler uses to resolve its RLS-scoped
// repository from the ensemble in its URL. Returns the repository, or a
// JSON error Response when the caller is not an active member of that ensemble — so the
// shared active-ensemble cookie never decides a write target.
//
//   const repo = await repoForRoute(ensembleId);
//   if (repo instanceof NextResponse) return repo;
//
// `repo instanceof NextResponse` is the membership/auth guard; past it, repo is the scoped
// Repository.

import { NextResponse } from "next/server";
import { dataSource } from "./env";
import {
    getRepositoryFor,
    RepositoryAccessError,
    UUID_RE,
    type Repository,
} from "./repository";

export async function repoForRoute(
    ensembleId: string,
    opts?: { requireDirector?: boolean },
): Promise<Repository | NextResponse> {
    try {
        return await getRepositoryFor(ensembleId, opts);
    } catch (e) {
        if (e instanceof RepositoryAccessError) {
            return NextResponse.json(
                { error: e.message },
                { status: e.status },
            );
        }
        throw e;
    }
}

// Guard an inner path segment bound to a uuid column (event/setlist/song/member id, etc.).
// getRepositoryFor already validates the ensemble id; the inner segments reach the repository
// unchecked, where a malformed value raises Postgres 22P02 and surfaces as a 500 instead of a
// clean 404. Call this right after reading the route params:
//   const bad = badPathUuid(id); if (bad) return bad;
// Returns a 404 Response when any id is not a uuid, else null.
//
// Supabase-mode only: the guard exists to stop a 22P02 500 from a Postgres uuid cast. The mock
// oracle uses human-readable ids ('church', 'reh1', 'song-*'), which are valid keys there and a
// missing one already returns a clean 404, so validating would wrongly reject every mock id.
// getRepositoryFor is the mirror: it also validates only in supabase mode, but the ensemble
// segment is a public_id token, so it checks isPublicId rather than a uuid.
export function badPathUuid(...ids: string[]): NextResponse | null {
    if (dataSource !== "supabase") return null;
    return ids.every((id) => UUID_RE.test(id))
        ? null
        : NextResponse.json({ error: "not found" }, { status: 404 });
}
