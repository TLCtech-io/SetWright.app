// PATCH  /api/e/:ensembleId/playground/:id -> rename a program or set its songs
// DELETE /api/e/:ensembleId/playground/:id -> remove a saved program
// Director-only writes.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coercePlaygroundPatch } from "@/lib/playgroundInput";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PATCH(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);

    // Any existing song (active or archived) may stay in a program; archiving a song
    // must not silently drop it from a saved program. The add picker is the only thing
    // restricted to active songs, on the client.
    const songs = await repo.listSongs();
    const validSongIds = new Set(songs.map((s) => s.id));
    const parsed = coercePlaygroundPatch(raw, validSongIds);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const updated = await repo.updatePlayground(id, parsed.value);
    if (!updated) {
        return NextResponse.json(
            { error: "program not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({ id: updated.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const res = await repo.deletePlayground(id);
    if (res.ok) {
        return NextResponse.json({ ok: true });
    }
    if (res.reason === "assigned") {
        return NextResponse.json(
            {
                error: "This program is assigned to an event and cannot be deleted.",
            },
            { status: 409 },
        );
    }
    return NextResponse.json({ error: "program not found" }, { status: 404 });
}
