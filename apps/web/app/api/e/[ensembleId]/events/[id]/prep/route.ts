// PUT /api/e/:ensembleId/events/:id/prep {songIds} -> replace a gig's prep targets
//
// Prep targets are gig-only (a rehearsal is the preparation), so this rejects a rehearsal
// the way the agenda route rejects a gig. Director-only. The whole set is replaced.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coercePrepSongIds } from "@/lib/rehearsalInput";
import { resyncEventMemberSnapshots } from "@/lib/sharedDraft";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const event = await repo.getEvent(id);
    if (!event)
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    if (event.kind !== "gig") {
        return NextResponse.json(
            { error: "only a gig has prep targets" },
            { status: 400 },
        );
    }

    const validSongIds = new Set((await repo.listSongs()).map((s) => s.id));
    const songIds = coercePrepSongIds(
        await req.json().catch(() => null),
        validSongIds,
    );
    if (songIds === null)
        return NextResponse.json({ error: "bad body" }, { status: 400 });

    await repo.savePrepTargets(id, songIds);
    await resyncEventMemberSnapshots(repo, id);
    return NextResponse.json({ ok: true });
}

// PATCH {songId, on} -> add or remove ONE song from a gig's prep targets. Lets the setlist
// editor promote a single set song to prep (or drop it) without resending the whole list.
export async function PATCH(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const event = await repo.getEvent(id);
    if (!event)
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    if (event.kind !== "gig") {
        return NextResponse.json(
            { error: "only a gig has prep targets" },
            { status: 400 },
        );
    }

    const body = (await req.json().catch(() => null)) as {
        songId?: unknown;
        on?: unknown;
    } | null;
    const songId = typeof body?.songId === "string" ? body.songId : null;
    const on = typeof body?.on === "boolean" ? body.on : null;
    if (!songId || on === null)
        return NextResponse.json({ error: "bad body" }, { status: 400 });
    const validSongIds = new Set((await repo.listSongs()).map((s) => s.id));
    if (!validSongIds.has(songId))
        return NextResponse.json({ error: "unknown song" }, { status: 400 });

    await repo.togglePrepTarget(id, songId, on);
    await resyncEventMemberSnapshots(repo, id);
    return NextResponse.json({ ok: true });
}
