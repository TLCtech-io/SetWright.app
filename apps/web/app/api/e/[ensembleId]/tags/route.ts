// POST  /api/e/:ensembleId/tags            -> add a tag to the vocabulary
// PATCH /api/e/:ensembleId/tags { order }  -> reorder the vocabulary (sets sortOrder)
//
// The style-tag vocabulary. Reads go through the db in server components; these
// are the director-only write seams. Under Supabase they become RLS-scoped
// writes only a director may run.

import { NextResponse } from "next/server";
import { coerceTagInput } from "@/lib/tagInput";
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
    const parsed = coerceTagInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.createTag(parsed.value);
    if (!result.ok) {
        return NextResponse.json(
            { error: "a tag with that name already exists" },
            { status: 409 },
        );
    }
    return NextResponse.json({ id: result.tag.id }, { status: 201 });
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
    await repo.reorderTags(parsed.value);
    return NextResponse.json({ ok: true });
}
