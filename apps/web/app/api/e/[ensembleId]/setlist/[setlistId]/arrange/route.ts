// POST /api/e/:ensembleId/setlist/:id/arrange {order} -> re-sequenced order + seams + padded total
//
// Auto-arrange re-orders the songs already in the set (honoring the opener/closer
// pins) without re-drafting, so nothing is swapped in or out. Distinct from POST
// /setlist/:id, which re-runs the whole funnel and can change which songs are in.

import { NextResponse } from "next/server";
import { sequenceForOrder } from "@repertoire/api";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { getSource } from "@/lib/source";
import { resyncMemberSnapshot } from "@/lib/sharedDraft";
import { coerceIdList } from "@/lib/limits";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;

    // R-tenant: the setlist must belong to the URL's ensemble (repoForRoute validates membership).
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // Arrange changes the running order — a performed or finalized set is read-only.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }

    // setlistLockReason returns null for a missing setlist, so confirm it exists in this ensemble.
    if (!(await repo.getSetlistMeta(setlistId))) {
        return NextResponse.json(
            { error: "setlist not found in this ensemble" },
            { status: 404 },
        );
    }

    // A literal `null` body is valid JSON, so coalesce the parsed value before reading a field.
    const body = ((await req.json().catch(() => null)) ?? {}) as {
        order?: unknown;
    };

    // Cap the order so a pathological client can't hand the sequencer an absurd list.
    const order = coerceIdList(body.order);

    const source = getSource();
    const res = await sequenceForOrder(source, setlistId, order);
    if (res.status !== 200) {
        return NextResponse.json(res.body, { status: res.status });
    }

    // Auto-arrange is an explicit ordering action: persist the re-sequenced order as the director's
    // arrangement so it survives reload and is what publish/share freeze (loadSetlist applies it).
    // Draft-only; resync the shared copy; return the current version for the editor's break-edit token.
    await repo.setArrangedOrder(setlistId, res.body.order);
    await resyncMemberSnapshot(repo, setlistId).catch(() => {});
    const meta = await repo.getSetlistMeta(setlistId).catch(() => null);
    return NextResponse.json(
        { ...res.body, version: meta?.version },
        { status: 200 },
    );
}
