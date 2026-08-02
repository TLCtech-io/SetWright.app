// POST /api/e/:ensembleId/events -> create an event (and its setlist, so it is draftable)
//
// Reads (the events list, a single event) go through the db in server components;
// this is the write seam. Under Supabase it becomes an RLS-scoped insert that
// only a director may run.

import { NextResponse } from "next/server";
import { coerceEventInput } from "@/lib/eventInput";
import { repoForRoute } from "@/lib/apiEnsemble";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const vocab = new Set((await repo.listTags()).map((t) => t.name));
    const typeIds = new Set((await repo.listEventTypes()).map((t) => t.id));
    const parsed = coerceEventInput(raw, vocab, typeIds);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const event = await repo.createEvent(parsed.value);
    return NextResponse.json(
        { id: event.id, publicId: event.publicId },
        { status: 201 },
    );
}
