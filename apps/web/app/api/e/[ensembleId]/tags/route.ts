// POST  /api/e/:ensembleId/tags            -> add a tag to the vocabulary
// PATCH /api/e/:ensembleId/tags { order }  -> reorder the vocabulary (sets sortOrder)
//
// The style-tag vocabulary. Reads go through the db in server components; these
// are the director-only write seams. Under Supabase they become RLS-scoped
// writes only a director may run.

import { NextResponse } from "next/server";
import { coerceTagInput } from "@/lib/tagInput";
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
    // req.json() parses a literal `null` body successfully (it is valid JSON), so the
    // catch fallback doesn't fire — guard for it before dereferencing .order.
    const body = await req.json().catch(() => null);
    const order =
        body && typeof body === "object"
            ? (body as { order?: unknown }).order
            : undefined;
    if (!Array.isArray(order) || !order.every((x) => typeof x === "string")) {
        return NextResponse.json(
            { error: "order must be an array of ids" },
            { status: 400 },
        );
    }
    await repo.reorderTags(order as string[]);
    return NextResponse.json({ ok: true });
}
