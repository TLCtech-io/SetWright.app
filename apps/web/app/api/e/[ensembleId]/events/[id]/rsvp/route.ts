// PUT /api/e/:ensembleId/events/:id/rsvp { status }
//   -> the signed-in member sets their OWN attendance for one event (in/out/tentative).
//
// Self-scoped: set_my_availability resolves the caller's member from auth.uid() and the
// availability_write self RLS branch authorizes the single-row upsert — this is NOT the
// director's set_availability (which replaces everyone's rows and needs event UPDATE).
// repoForRoute admits any active member, not just directors.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceRsvpStatus } from "@/lib/rsvpInput";

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string; id: string }> },
) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId);
    if (repo instanceof NextResponse) return repo;

    const raw = await req.json().catch(() => null);
    const parsed = coerceRsvpStatus(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });

    try {
        await repo.setMyAvailability(id, parsed.value);
    } catch {
        // The RPC raises for a non-existent event or a caller who isn't a member of it.
        return NextResponse.json(
            { error: "could not set your RSVP for that event" },
            { status: 400 },
        );
    }
    return NextResponse.json({ ok: true, status: parsed.value });
}
