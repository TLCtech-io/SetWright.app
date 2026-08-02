// POST /api/e/:ensembleId/songs  -> create a song (+ its parts)
//
// Reads (the repertoire list, a single song) go straight through the db in the
// server components; this is the write seam. Under Supabase it becomes an
// RLS-scoped insert that only a director may run.

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { coerceSongInput } from "@/lib/songInput";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceSongInput(
        raw,
        await repo.listTags(),
        await repo.listVoiceParts(),
    );
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const song = await repo.createSong(parsed.value);
    return NextResponse.json({ id: song.id }, { status: 201 });
}
