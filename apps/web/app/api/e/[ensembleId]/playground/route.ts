// POST /api/e/:ensembleId/playground {name} -> create a saved program (playground).
// Director-only write.

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { coercePlaygroundCreate } from "@/lib/playgroundInput";

export async function POST(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coercePlaygroundCreate(raw);
    if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const pg = await repo.createPlayground(parsed.value.name);
    return NextResponse.json(
        { id: pg.id, publicId: pg.publicId },
        { status: 201 },
    );
}
