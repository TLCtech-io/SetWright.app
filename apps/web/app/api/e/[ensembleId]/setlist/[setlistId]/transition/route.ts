// POST /api/e/:ensembleId/setlist/:id/transition { songId, seconds } -> set or clear a segue override.
//
// The gap LEAVING a song, in seconds (0 = attacca); null clears it back to the event's
// per-song padding. Keyed by song, so it sticks to its (setlist, song) pair across
// re-drafts. Under Supabase this is an upsert of setlist_item.transition_seconds.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { loadSetlist } from "@/lib/setlist";
import { resyncMemberSnapshot } from "@/lib/sharedDraft";
import { coerceTransition } from "@/lib/transitionInput";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    // A performed or finalized set is locked — reject segue writes.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }
    // Scope valid songs to THIS setlist's event pool, not the whole catalog, so a segue
    // can't be parked on a song outside the event and surface later in a re-draft.
    const loaded = await loadSetlist(repo, setlistId);
    if (loaded.status !== 200) {
        return NextResponse.json(loaded.body, { status: loaded.status });
    }
    const raw = await req.json().catch(() => null);
    const validSongIds = new Set(loaded.body.catalog.map((c) => c.id));
    const parsed = coerceTransition(raw, validSongIds);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (
        !(await repo.setTransition(
            setlistId,
            parsed.value.songId,
            parsed.value.seconds,
        ))
    ) {
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }
    // Best-effort: keep the members' shared copy current if this set is shared. That resync (when
    // shared) bumps the setlist version, so hand the current version back — the open SetlistView
    // advances its break-edit token to it and a following break edit does not false-conflict.
    await resyncMemberSnapshot(repo, setlistId).catch(() => {});
    const meta = await repo.getSetlistMeta(setlistId).catch(() => null);
    return NextResponse.json({ ok: true, version: meta?.version });
}
