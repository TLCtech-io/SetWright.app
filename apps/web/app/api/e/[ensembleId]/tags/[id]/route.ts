// PUT    /api/e/:ensembleId/tags/:id  -> rename / recategorize (cascades to songs + events)
// DELETE /api/e/:ensembleId/tags/:id  -> remove it (cascades off every song and event)

import { NextResponse } from "next/server";
import { coerceTagInput } from "@/lib/tagInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceTagInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.updateTag(id, parsed.value);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json({ error: "tag not found" }, { status: 404 })
            : NextResponse.json(
                  { error: "a tag with that name already exists" },
                  { status: 409 },
              );
    }
    return NextResponse.json({ id: result.tag.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deleteTag(id);
    if (!result.ok) {
        return NextResponse.json({ error: "tag not found" }, { status: 404 });
    }
    return NextResponse.json({
        ok: true,
        removedFromSongs: result.removedFromSongs,
        removedFromEvents: result.removedFromEvents,
        removedFromEventTypes: result.removedFromEventTypes,
    });
}
