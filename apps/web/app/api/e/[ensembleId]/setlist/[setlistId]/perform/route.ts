// POST /api/e/:ensembleId/setlist/:id/perform -> freeze the set and mark it performed.
//
// Freezes the performed order and stamps last_performed on the songs that ran, so
// the set becomes an immutable record and the next draft spreads repetition. The
// order honors the director's on-screen arrangement when sent, falling back to the
// drafted order. Under Supabase this is the perform_setlist RPC, which freezes the
// order into setlist_item, snapshots soloists, and stamps performed_date.

import { NextResponse } from "next/server";
import { songsOf } from "@repertoire/core";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { loadSetlist } from "@/lib/setlist";
import { resolvePerformOrder } from "@/lib/performOrder";
import { coerceIdList } from "@/lib/limits";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A performed set is an immutable record: never re-freeze it.
    if (await repo.getPerformedSet(setlistId)) {
        return NextResponse.json(
            { error: "this set is already performed" },
            { status: 409 },
        );
    }

    const loaded = await loadSetlist(repo, setlistId);
    if (loaded.status !== 200) {
        return NextResponse.json(loaded.body, { status: loaded.status });
    }

    const setIds = songsOf(loaded.body.draft.set).map((e) => e.song.id);

    // Keep the sent order, scoped to songs actually in the set, then append any set
    // song the client did not list (defensive), so the frozen order is complete.
    const raw = await req.json().catch(() => null);

    // Cap the sent order; any genuine set song the cap drops is re-appended below, so the freeze
    // stays complete. setIds is server-built (bounded by the draft), so it needs no cap.
    const sent = coerceIdList(
        raw && typeof raw === "object"
            ? (raw as { order?: unknown }).order
            : undefined,
    );
    // Scope to the set, dedupe (parity with perform_setlist's group-by-song_id), then append any set
    // song the client omitted, so the frozen record is complete. See resolvePerformOrder.
    const ordered = resolvePerformOrder(sent, setIds);

    // Nothing drafted (e.g. everyone out): refuse rather than freeze an empty record.
    if (ordered.length === 0) {
        return NextResponse.json(
            { error: "nothing to perform" },
            { status: 400 },
        );
    }

    // markPerformed returns false when the freeze did not happen — most often a concurrent
    // freeze won the row lock (it serializes now), or the set is already performed / the caller
    // is not a director. Surface that as a conflict rather than a misleading success.
    const performed = await repo.markPerformed(setlistId, ordered);
    if (!performed) {
        return NextResponse.json(
            {
                error: "the set could not be performed; it may already be frozen",
            },
            { status: 409 },
        );
    }
    return NextResponse.json({ performed: true }, { status: 200 });
}
