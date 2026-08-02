// PUT /api/e/:ensembleId/events/:id/record {date, rehearsedSongIds, attendance} -> record a rehearsal
//
// Two coordinated writes: stamp last_rehearsed for the songs actually run, and replace the
// event's recorded attendance. Rehearsal-only and director-only, mirroring the agenda route.
// Both writes are idempotent/replace, so a retry after a partial failure converges.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceRecordInput } from "@/lib/rehearsalInput";

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
            { error: "only a rehearsal is recorded here" },
            { status: 400 },
        );
    }

    const [validSongIds, validMemberIds] = await Promise.all([
        repo.listSongs().then((s) => new Set(s.map((x) => x.id))),
        repo.listRoster().then((r) => new Set(r.map((x) => x.id))),
    ]);
    const body = coerceRecordInput(
        await req.json().catch(() => null),
        validSongIds,
        validMemberIds,
        event.resolved.eventDate,
    );
    if (body === null)
        return NextResponse.json({ error: "bad body" }, { status: 400 });

    if (body.rehearsedSongIds.length > 0)
        await repo.markSongsRehearsed(body.rehearsedSongIds, body.date);
    await repo.saveAttendance(id, body.attendance);
    return NextResponse.json({ ok: true });
}
