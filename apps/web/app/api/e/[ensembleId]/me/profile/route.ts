// PUT /api/e/:ensembleId/me/profile { displayName, rangeLow, rangeHigh }
//   -> the signed-in member edits their OWN record (display name + vocal range).
//
// The target member id is resolved server-side from the caller's own membership — never
// taken from the body — so a member can only edit themselves (the update_my_profile RPC
// enforces this too, with its m.user_id = auth.uid() guard). repoForRoute admits any active
// member of the ensemble (not director-only).

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { getMyMembership } from "@/lib/ensembles";
import { coerceProfileInput } from "@/lib/profileInput";

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId);
    if (repo instanceof NextResponse) return repo;

    const me = await getMyMembership(ensembleId);
    if (!me)
        return NextResponse.json(
            { error: "not a member of this ensemble" },
            { status: 403 },
        );

    const raw = await req.json().catch(() => null);
    const parsed = coerceProfileInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });

    const updated = await repo.updateMyProfile(me.memberId, parsed.value);
    if (!updated)
        return NextResponse.json(
            { error: "could not update your profile" },
            { status: 404 },
        );
    return NextResponse.json({ ok: true, displayName: updated.displayName });
}
