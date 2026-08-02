// POST /api/e/:ensembleId/members -> add a singer to the roster
//
// Reads (the roster list, a single member) go through the db in server
// components; this is the write seam. Under Supabase it becomes an RLS-scoped
// insert that only a director may run.

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { coerceMemberInput } from "@/lib/memberInput";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceMemberInput(raw, await repo.listVoiceParts());
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const member = await repo.createMember(parsed.value);
    return NextResponse.json(
        { id: member.id, publicId: member.publicId },
        { status: 201 },
    );
}
