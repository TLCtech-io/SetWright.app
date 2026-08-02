// PUT    /api/e/:ensembleId/events/:id -> update an event's policy (name, date, target, on/off
//                           book, explicit, padding, context tags)
// DELETE /api/e/:ensembleId/events/:id -> remove the event and its setlists

import { NextResponse } from "next/server";
import { coerceEventInput } from "@/lib/eventInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { resyncEventMemberSnapshots } from "@/lib/sharedDraft";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const vocab = new Set((await repo.listTags()).map((t) => t.name));
    const typeIds = new Set((await repo.listEventTypes()).map((t) => t.id));
    const parsed = coerceEventInput(raw, vocab, typeIds);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const updated = await repo.updateEvent(id, parsed.value);
    if (!updated) {
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    }
    // Event policy (target length, padding, context tags, book/explicit) feeds the drafter, so a change
    // can shift any shared draft's order. Refresh them, best-effort, so the member preview keeps up.
    await resyncEventMemberSnapshots(repo, id);
    return NextResponse.json({ id: updated.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deleteEvent(id);
    if (result.ok) {
        return NextResponse.json({ ok: true });
    }
    if (result.reason === "has-performed") {
        return NextResponse.json(
            {
                error: "this event has a performed set; archive it instead of deleting",
            },
            { status: 409 },
        );
    }
    return NextResponse.json({ error: "event not found" }, { status: 404 });
}
