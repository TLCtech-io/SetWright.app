// PUT    /api/e/:ensembleId/voice-parts/:id  -> rename / retune a section
// DELETE /api/e/:ensembleId/voice-parts/:id  -> remove it (refused while a chart still calls
//        for it; member links to it cascade away, per the schema)

import { NextResponse } from "next/server";
import { coerceVoicePartInput } from "@/lib/voicePartInput";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

export async function PUT(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceVoicePartInput(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    const result = await repo.updateVoicePart(id, parsed.value);
    if (!result.ok) {
        return result.reason === "not-found"
            ? NextResponse.json({ error: "section not found" }, { status: 404 })
            : NextResponse.json(
                  { error: "a section with that name already exists" },
                  { status: 409 },
              );
    }
    return NextResponse.json({ id: result.voicePart.id });
}

export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deleteVoicePart(id);
    if (!result.ok) {
        if (result.reason === "not-found") {
            return NextResponse.json(
                { error: "section not found" },
                { status: 404 },
            );
        }
        return NextResponse.json(
            {
                error: `still used by ${result.partCount} part${result.partCount === 1 ? "" : "s"}; reassign them first`,
            },
            { status: 409 },
        );
    }
    return NextResponse.json({
        ok: true,
        removedMemberships: result.removedMemberships,
    });
}
