// POST /api/e/:ensembleId/setlist/:id/order {order} -> PERSIST the director's manual running order,
// then return the re-cost (seams + padded total) and the new version.
//
// A drag / Auto-arrange calls this so the arrangement survives a reload and is what publish and share
// capture (loadSetlist applies arranged_order over the drafter's order). Draft-only. The persist bumps
// the setlist version (moddatetime), and — when the set is member-visible (published or shared) — the
// resync bumps it again, so the response carries the current version for the editor's break-edit
// token. The stored order is reconciled to the drafted set on read, so an unknown/stale id here is
// harmless.

import { NextResponse } from "next/server";
import { seamsForOrder } from "@repertoire/api";
import type { SetBreak } from "@repertoire/core";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { getSource } from "@/lib/source";
import { resyncMemberSnapshot } from "@/lib/sharedDraft";
import { coerceIdList } from "@/lib/limits";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A performed or finalized set has a frozen order — reject manual reorders.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }

    // A literal `null` body is valid JSON, so coalesce before reading. coerceIdList caps the list.
    const raw = ((await req.json().catch(() => null)) ?? {}) as {
        order?: unknown;
    };
    const order = coerceIdList(raw.order);

    const source = getSource();
    const locks = (await source.hydrateLocks(setlistId)) as {
        eventId: string | null;
        transitions?: { songId: string; seconds: number }[];
        breaks?: SetBreak[];
    };
    if (!locks || locks.eventId === null) {
        return NextResponse.json(
            { error: "setlist not found or not visible" },
            { status: 404 },
        );
    }

    // Persist the arrangement (setArrangedOrder is draft-only), then re-cost the exact order the same
    // way the /seams path does (within-segment seams, break-aware clock).
    await repo.setArrangedOrder(setlistId, order);
    const res = await seamsForOrder(
        source,
        locks.eventId,
        order,
        locks.transitions ?? [],
        locks.breaks ?? [],
    );
    if (res.status !== 200) {
        return NextResponse.json(res.body, { status: res.status });
    }

    // Best-effort: keep the members' shared copy on the new order (it reads the persisted arrangement).
    await resyncMemberSnapshot(repo, setlistId).catch(() => {});
    const meta = await repo.getSetlistMeta(setlistId).catch(() => null);
    return NextResponse.json(
        { ...res.body, version: meta?.version },
        { status: 200 },
    );
}
