// PUT /api/e/:ensembleId/settings -> update the active ensemble's row (name, timezone,
// confidence visibility). RLS (ensemble_update) authorizes the write only for the
// ensemble's director; a non-director's write matches no row and we return 403.

import { NextResponse } from "next/server";
import { repoForRoute } from "@/lib/apiEnsemble";
import { coerceEnsembleSettings } from "@/lib/ensembleSettingsInput";
import { CONFLICT_MESSAGE, readExpectedVersion } from "@/lib/writeResult";

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ ensembleId: string }> },
) {
    const { ensembleId } = await params;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const parsed = coerceEnsembleSettings(raw);
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
    const result = await repo.updateEnsembleSettings(
        parsed.value,
        expectedVersion,
    );
    if (!result.ok) {
        return result.reason === "conflict"
            ? NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 })
            : NextResponse.json(
                  { error: "only a director can change ensemble settings" },
                  { status: 403 },
              );
    }
    return NextResponse.json({ ok: true, version: result.version });
}
