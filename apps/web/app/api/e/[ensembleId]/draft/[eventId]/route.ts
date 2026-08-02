// GET /api/e/:ensembleId/draft/:eventId
//
// The whole binding: pull the id, build the source, call the drafter, pass the
// status and body straight through. The data source lives entirely in getSource;
// this handler stays as is (it is where the per-request user client is built).

import { NextResponse } from "next/server";
import { draftSetForEvent } from "@repertoire/api";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { getSource } from "@/lib/source";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ ensembleId: string; eventId: string }> },
) {
    const { ensembleId, eventId } = await params;
    const bad = badPathUuid(eventId);
    if (bad) return bad;

    // R-tenant: the event must belong to the URL's ensemble. RLS alone authorizes a
    // multi-ensemble user across ALL their ensembles, so without this a tenant-B event could
    // be drafted under a tenant-A URL. getEvent is scoped to the URL ensemble, so a mismatch
    // (or non-member) returns undefined here.
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const ev = await repo.getEvent(eventId);
    if (!ev) {
        return NextResponse.json(
            { error: "event not found in this ensemble" },
            { status: 404 },
        );
    }

    // A rehearsal has no gig set to fill; the drafter runs only on gigs.
    if (ev.kind !== "gig") {
        return NextResponse.json(
            { error: "a rehearsal has no gig set to draft" },
            { status: 400 },
        );
    }
    const res = await draftSetForEvent(getSource(), eventId);
    return NextResponse.json(res.body, { status: res.status });
}
