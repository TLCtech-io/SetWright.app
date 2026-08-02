// PUT /api/e/:ensembleId/me/confidence { partId, confidence }
//   -> the signed-in member reports their OWN confidence on a part they're cast on.
//
// Self-scoped: setMyConfidence resolves the caller's casting on that part and writes via the
// set_my_confidence RPC (owner-only; the casting_confidence_owner trigger reverts a non-self
// write). repoForRoute admits any active member.

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { coerceConfidence } from "@/lib/confidenceInput";

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId);
    if (repo instanceof NextResponse) return repo;

    const raw = await req.json().catch(() => null);
    const parsed = coerceConfidence(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });

    await repo.setMyConfidence(parsed.partId, parsed.confidence);
    return NextResponse.json({ ok: true });
}
