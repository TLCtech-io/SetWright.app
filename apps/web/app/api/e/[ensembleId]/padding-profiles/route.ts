// POST /api/e/:ensembleId/padding-profiles -> add a reusable padding profile
//
// Reusable time-overhead presets. Director-only write seam (RLS-scoped under Supabase).

import { NextResponse } from "next/server";
import { coercePaddingProfileInput } from "@/lib/paddingProfileInput";
import { repoForRoute } from "@/lib/apiEnsemble";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coercePaddingProfileInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.createPaddingProfile(parsed.value);
    if (!result.ok) {
        return NextResponse.json(
            { error: "a profile with that name already exists" },
            { status: 409 },
        );
    }
    return NextResponse.json({ id: result.profile.id }, { status: 201 });
}
