// POST /api/e/:ensembleId/setlist/:id/note { songId, note } -> set or clear a per-song annotation.
//
// Keyed by song, so a note sticks to its (setlist, song) pair across re-drafts. Under
// Supabase this is an upsert of setlist_item.note.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { loadSetlist } from "@/lib/setlist";
import { coerceNote } from "@/lib/noteInput";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    // A performed or finalized set is locked — reject annotation writes.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }
    // Scope valid songs to THIS setlist's event pool, not the whole catalog, so a note
    // can't be parked on a song outside the event and surface later in a re-draft. (Under
    // Supabase this is a scoped query, not a re-draft.)
    const loaded = await loadSetlist(repo, setlistId);
    if (loaded.status !== 200) {
        return NextResponse.json(loaded.body, { status: loaded.status });
    }
    const raw = await req.json().catch(() => null);
    const validSongIds = new Set(loaded.body.catalog.map((c) => c.id));
    const parsed = coerceNote(raw, validSongIds);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (
        !(await repo.setItemNote(
            setlistId,
            parsed.value.songId,
            parsed.value.note,
        ))
    ) {
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({ ok: true });
}
