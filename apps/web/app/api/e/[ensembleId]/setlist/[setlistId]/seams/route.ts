// POST /api/e/:ensembleId/setlist/:id/seams {order} -> seams + padded total for a manual order
//
// The drafter re-sequences each draft, so a hand-arrangement is re-costed here
// without re-drafting. Resolve the setlist's event, then ask core (via the api)
// to recompute the seams for the given order.

import { NextResponse } from "next/server";
import { seamsForOrder } from "@repertoire/api";
import type { SetBreak } from "@repertoire/core";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { getSource } from "@/lib/source";
import { coerceIdList } from "@/lib/limits";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;

    // R-tenant: the setlist must belong to the URL's ensemble (RLS authorizes a multi-ensemble
    // user across all their ensembles; getSetlistMeta is scoped to the URL ensemble).
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
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

    // Cap the hand-arranged order so a pathological client can't hand the re-cost an absurd list.
    const order = coerceIdList(body.order);

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

    // Honor the setlist's segues and breaks so the hand-arrangement re-cost matches the
    // draft: within-segment seams only, and the clock counts the break time.
    const res = await seamsForOrder(
        source,
        locks.eventId,
        order,
        locks.transitions ?? [],
        locks.breaks ?? [],
    );
    return NextResponse.json(res.body, { status: res.status });
}
