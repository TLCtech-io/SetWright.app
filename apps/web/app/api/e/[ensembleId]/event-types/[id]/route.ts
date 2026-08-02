// PUT    /api/e/:ensembleId/event-types/:id -> edit a type (name, padding profile, policy, tag rules)
// DELETE /api/e/:ensembleId/event-types/:id -> remove it; events created from it keep their snapshot
//        and become untyped (provenance pointer cleared)

import { NextResponse } from "next/server";
import { coerceEventTypeInput } from "@/lib/eventTypeInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const tags = await repo.listTags();
    const vocab = new Set(tags.map((t) => t.name));
    const parsed = coerceEventTypeInput(raw, vocab);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.updateEventType(id, parsed.value);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json(
                  { error: "event type not found" },
                  { status: 404 },
              )
            : NextResponse.json(
                  { error: "an event type with that name already exists" },
                  { status: 409 },
              );
    }
    return NextResponse.json({ id: result.eventType.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deleteEventType(id);
    if (!result.ok)
        return NextResponse.json(
            { error: "event type not found" },
            { status: 404 },
        );
    return NextResponse.json({ ok: true, untypedEvents: result.untypedEvents });
}
