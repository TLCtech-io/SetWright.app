// PUT   /api/e/:ensembleId/songs/:id          -> update a song (attributes + parts)
// PATCH /api/e/:ensembleId/songs/:id {status} -> archive or restore
//
// Update reconciles parts by id, so casting on unchanged parts survives an edit.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import type { SongStatus } from "@/lib/db";
import { coerceSongInput } from "@/lib/songInput";
import { CONFLICT_MESSAGE, readExpectedVersion } from "@/lib/writeResult";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceSongInput(
        raw,
        await repo.listTags(),
        await repo.listVoiceParts(),
    );
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const expectedVersion = readExpectedVersion(raw);
    if (!expectedVersion) {
        return NextResponse.json(
            { error: "missing version token" },
            { status: 400 },
        );
    }
    const result = await repo.updateSong(id, parsed.value, expectedVersion);
    if (!result.ok) {
        return result.reason === "conflict"
            ? NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 })
            : NextResponse.json({ error: "song not found" }, { status: 404 });
    }
    return NextResponse.json({ id, version: result.version });
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
    if (body.status !== "active" && body.status !== "archived") {
        return NextResponse.json(
            { error: "status must be active or archived" },
            { status: 400 },
        );
    }
    const status: SongStatus = body.status;
    const updated = await repo.setSongStatus(id, status);
    if (!updated) {
        return NextResponse.json({ error: "song not found" }, { status: 404 });
    }
    return NextResponse.json({ id: updated.id, status: updated.status });
}
