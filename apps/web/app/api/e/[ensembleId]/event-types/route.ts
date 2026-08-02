// POST  /api/e/:ensembleId/event-types            -> add an event type
// PATCH /api/e/:ensembleId/event-types { order }  -> reorder the vocabulary (sets sortOrder)
//
// The event-type presets. Director-only write seams (RLS-scoped under Supabase).

import { NextResponse } from "next/server";
import { coerceEventTypeInput } from "@/lib/eventTypeInput";
import { coerceReorderInput } from "@/lib/reorderInput";
import { repoForRoute } from "@/lib/apiEnsemble";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const tags = await repo.listTags();
    const vocab = new Set(tags.map((t) => t.name));
    const parsed = coerceEventTypeInput(raw, vocab);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.createEventType(parsed.value);
    if (!result.ok) {
        return NextResponse.json(
            { error: "an event type with that name already exists" },
            { status: 409 },
        );
    }
    return NextResponse.json({ id: result.eventType.id }, { status: 201 });
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceReorderInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    await repo.reorderEventTypes(parsed.value);
    return NextResponse.json({ ok: true });
}
