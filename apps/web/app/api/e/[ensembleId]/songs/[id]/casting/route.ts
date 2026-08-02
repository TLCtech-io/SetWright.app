// PUT /api/e/:ensembleId/songs/:id/casting {castings} -> replace who covers the song's parts
//
// The director assigns coverage and the primary (lead). Confidence is normally
// the member's own self-report; in the mock the director sets it too. Scoped and
// validated against the song's own parts and the roster.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceCasting } from "@/lib/castingInput";
import { CONFLICT_MESSAGE, readExpectedVersion } from "@/lib/writeResult";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const parts = await repo.getSongParts(id);
    const validPartIds = new Set(parts.map((p) => p.id));
    const members = await repo.listMembers();
    const validMemberIds = new Set(members.map((m) => m.id));

    const raw = await req.json().catch(() => null);
    const cast = coerceCasting(raw, validPartIds, validMemberIds);
    if (cast === null) {
        return NextResponse.json({ error: "bad body" }, { status: 400 });
    }
    const expectedVersion = readExpectedVersion(raw);
    if (!expectedVersion) {
        return NextResponse.json(
            { error: "missing version token" },
            { status: 400 },
        );
    }
    // The version check returns a WriteResult; a constraint/RLS failure during the transactional
    // replace instead throws. Map that to a 409 the client can act on (reload + retry), not an
    // opaque 500.
    let result;
    try {
        result = await repo.setSongCasting(id, cast, expectedVersion);
    } catch {
        return NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 });
    }
    if (!result.ok) {
        return result.reason === "conflict"
            ? NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 })
            : NextResponse.json({ error: "song not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, version: result.version });
}
