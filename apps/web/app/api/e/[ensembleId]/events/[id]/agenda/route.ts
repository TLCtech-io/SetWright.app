// PUT /api/e/:ensembleId/events/:id/agenda {items} -> replace a rehearsal's agenda
//
// The agenda is a rehearsal-only plan (a gig has a setlist instead), so this rejects a
// gig the same way the setlists route rejects a rehearsal. Director-only. The whole list
// is replaced in one transactional RPC; items carry {songId, reason?, note?} in order.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceAgendaItems } from "@/lib/rehearsalInput";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const event = await repo.getEvent(id);
    if (!event)
        return NextResponse.json({ error: "event not found" }, { status: 404 });
    if (event.kind !== "rehearsal") {
        return NextResponse.json(
            { error: "only a rehearsal has an agenda" },
            { status: 400 },
        );
    }

    const validSongIds = new Set((await repo.listSongs()).map((s) => s.id));
    const items = coerceAgendaItems(
        await req.json().catch(() => null),
        validSongIds,
    );
    if (items === null)
        return NextResponse.json({ error: "bad body" }, { status: 400 });

    await repo.saveRehearsalAgenda(id, items);
    return NextResponse.json({ ok: true });
}
