// POST   /api/e/:ensembleId/setlist/:id/share -> share the live draft with members (opt-in).
// DELETE /api/e/:ensembleId/setlist/:id/share -> stop sharing.
//
// Distinct from publish. Publish freezes the order and is the final member record; sharing shows a
// live, updatable draft. Like publish, this re-drafts (loadSetlist) to capture the current order and
// stores it as draft_order; unlike publish it is not frozen — the order-changing routes call
// syncSharedDraftOrder so the member preview tracks the director's edits. Director-only.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { loadSetlist } from "@/lib/setlist";
import { draftSnapshot } from "@/lib/sharedDraft";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(_req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A performed set is already member-visible and immutable; there is nothing to share.
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
    const snapshot = draftSnapshot(loaded.body);
    if (snapshot.songIds.length === 0) {
        return NextResponse.json(
            { error: "nothing to share yet" },
            { status: 400 },
        );
    }

    const meta = await repo.shareSetlistDraft(setlistId, snapshot);
    if (!meta) {
        return NextResponse.json(
            { error: "the draft could not be shared" },
            { status: 409 },
        );
    }
    return NextResponse.json({ shareDraft: meta.shareDraft }, { status: 200 });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const meta = await repo.unshareSetlistDraft(setlistId);
    if (!meta) {
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({ shareDraft: meta.shareDraft }, { status: 200 });
}
