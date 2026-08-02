// POST /api/e/:ensembleId/events/:id/setlists {name} -> create a new setlist for the event
//
// An event can hold several setlists (Main set, Encore, Draft B). Each is its own
// draftable program.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A rehearsal has no gig set, so it must not get a setlist: a setlist is draftable
    // and performable, which would bypass the draft-route kind guard and contaminate
    // history. Reject at the endpoint, not just in the hidden-in-UI SetlistManager.
    const ev = await repo.getEvent(id);
    if (!ev) {
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    }
    if (ev.kind !== "gig") {
        return NextResponse.json(
            { error: "a rehearsal has no gig set" },
            { status: 400 },
        );
    }
    // A literal `null` body is valid JSON, so coalesce the parsed value before reading a field.
    const body = ((await req.json().catch(() => null)) ?? {}) as {
        name?: unknown;
    };
    const name =
        typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : null;
    const created = await repo.createSetlist(id, name);
    if (!created) {
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    }
    return NextResponse.json({ id: created.id }, { status: 201 });
}
