// PUT    /api/e/:ensembleId/padding-profiles/:id -> rename / retune a profile
// DELETE /api/e/:ensembleId/padding-profiles/:id -> remove it (clears the reference on event
//        types that used it; they fall back to the default padding)

import { NextResponse } from "next/server";
import { coercePaddingProfileInput } from "@/lib/paddingProfileInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coercePaddingProfileInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.updatePaddingProfile(id, parsed.value);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json({ error: "profile not found" }, { status: 404 })
            : NextResponse.json(
                  { error: "a profile with that name already exists" },
                  { status: 409 },
              );
    }
    return NextResponse.json({ id: result.profile.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deletePaddingProfile(id);
    if (!result.ok)
        return NextResponse.json(
            { error: "profile not found" },
            { status: 404 },
        );
    return NextResponse.json({
        ok: true,
        clearedFromTypes: result.clearedFromTypes,
    });
}
