// POST   /api/e/:ensembleId/setlist/:id/publish -> freeze the current draft order and make the set member-visible.
// DELETE /api/e/:ensembleId/setlist/:id/publish -> withdraw the set from members.
//
// A draft has no persisted order, so publish re-drafts (loadSetlist) to capture the current order,
// freezes the segues + breaks to it ONCE here so the mock and Supabase persist an identical frozen
// set, and stores it as the setlist's published snapshot. The member call sheet reads that snapshot,
// not a live re-draft, so a published set does not shift under the members. Director-only.

import { NextResponse } from "next/server";
import { normalizeBreaks, songsOf } from "@repertoire/core";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { loadSetlist } from "@/lib/setlist";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(_req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A performed set is already member-visible and immutable; there is nothing to publish.
    if (await repo.getPerformedSet(setlistId)) {
        return NextResponse.json(
            { error: "a performed set is already visible to members" },
            { status: 409 },
        );
    }

    const loaded = await loadSetlist(repo, setlistId);
    if (loaded.status !== 200) {
        return NextResponse.json(loaded.body, { status: loaded.status });
    }
    const songIds = songsOf(loaded.body.draft.set).map((e) => e.song.id);
    if (songIds.length === 0) {
        return NextResponse.json(
            { error: "nothing to publish" },
            { status: 400 },
        );
    }

    // Freeze once here: scope the segues to the order and clamp the breaks into range, so the stored
    // snapshot is clean and both adapters persist it verbatim (no per-adapter freeze to drift).
    const inOrder = new Set(songIds);
    const transitions: Record<string, number> = {};
    for (const [id, gap] of Object.entries(loaded.body.transitions)) {
        if (inOrder.has(id)) transitions[id] = gap;
    }
    const breaks = normalizeBreaks(loaded.body.breaks, songIds.length);

    const meta = await repo.publishSetlist(setlistId, {
        songIds,
        transitions,
        breaks,
    });
    if (!meta) {
        return NextResponse.json(
            { error: "the set could not be published" },
            { status: 409 },
        );
    }
    return NextResponse.json(
        { publishedAt: meta.publishedAt },
        { status: 200 },
    );
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const meta = await repo.unpublishSetlist(setlistId);
    if (!meta) {
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }

    // Return the repository's actual state, not a hardcoded null: a performed set is a no-op there and
    // stays published, so claiming publishedAt: null would falsely report it as withdrawn.
    return NextResponse.json(
        { publishedAt: meta.publishedAt },
        { status: 200 },
    );
}
