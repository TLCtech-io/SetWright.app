// PUT   /api/e/:ensembleId/members/:id          -> update a singer's record
// PATCH /api/e/:ensembleId/members/:id {status} -> archive or restore. Archiving cascades:
//        the singer's casting and RSVPs are pruned (handled in setMemberStatus).

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import type { MemberStatus } from "@/lib/db";
import { coerceMemberInput } from "@/lib/memberInput";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceMemberInput(raw, await repo.listVoiceParts());
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const result = await repo.updateMember(id, parsed.value);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json({ error: "member not found" }, { status: 404 })
            : NextResponse.json(
                  { error: "a group must keep at least one director" },
                  { status: 409 },
              );
    }
    return NextResponse.json({ id: result.member.id });
}

export async function PATCH(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    // A literal `null` body is valid JSON, so coalesce the parsed value before reading a field.
    const body = ((await req.json().catch(() => null)) ?? {}) as {
        status?: unknown;
    };
    if (body.status !== "active" && body.status !== "inactive") {
        return NextResponse.json(
            { error: "status must be active or inactive" },
            { status: 400 },
        );
    }
    const status: MemberStatus = body.status;
    const result = await repo.setMemberStatus(id, status);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json({ error: "member not found" }, { status: 404 })
            : NextResponse.json(
                  { error: "a group must keep at least one director" },
                  { status: 409 },
              );
    }
    return NextResponse.json({
        id: result.member.id,
        status: result.member.status,
    });
}
