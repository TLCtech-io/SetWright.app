// PUT /api/e/:ensembleId/events/:id/availability {availability} -> set who is in/out/tentative
//
// RSVP is per-event. In the real model members set their own; in the mock the
// director sets it. Scoped to the known roster and the three valid states.

import { NextResponse } from "next/server";
import { coerceAvailability } from "@/lib/eventInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { CONFLICT_MESSAGE, readExpectedVersion } from "@/lib/writeResult";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const validMemberIds = new Set((await repo.listMembers()).map((m) => m.id));
    const raw = await req.json().catch(() => null);
    const availability = coerceAvailability(raw, validMemberIds);
    if (availability === null) {
        return NextResponse.json({ error: "bad body" }, { status: 400 });
    }
    const expectedVersion = readExpectedVersion(raw);
    if (!expectedVersion) {
        return NextResponse.json(
            { error: "missing version token" },
            { status: 400 },
        );
    }

    // A constraint/RLS failure during the transactional replace throws; map it to a 409 the
    // client can act on, not an opaque 500.
    let result;
    try {
        result = await repo.setAvailability(id, availability, expectedVersion);
    } catch {
        return NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 });
    }
    if (!result.ok) {
        return result.reason === "conflict"
            ? NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 })
            : NextResponse.json({ error: "event not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, version: result.version });
}
