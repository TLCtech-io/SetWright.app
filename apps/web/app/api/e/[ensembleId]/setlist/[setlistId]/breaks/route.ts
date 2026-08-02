// POST /api/e/:ensembleId/setlist/:id/breaks { breaks } -> replace this setlist's breaks (intermissions).
//
// Bulk replace, like setting the whole pin state: the client owns the break list (ids and
// all) and sends the full set. Under Supabase this becomes an upsert/delete of setlist_break
// rows. Breaks are ordinal (afterPosition), so they survive a re-draft.

import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceBreaks } from "@/lib/breakInput";
import { resyncMemberSnapshot } from "@/lib/sharedDraft";
import { CONFLICT_MESSAGE, readExpectedVersion } from "@/lib/writeResult";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    // A performed or finalized set is locked — reject break edits.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }
    const raw = await req.json().catch(() => null);
    const parsed = coerceBreaks(raw);
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

    // A constraint/RLS failure during the transactional replace throws; map it to a 409 the
    // client can act on, not an opaque 500.
    let result;
    try {
        result = await repo.setBreaks(setlistId, parsed.value, expectedVersion);
    } catch {
        return NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 });
    }
    if (!result.ok) {
        return result.reason === "conflict"
            ? NextResponse.json({ error: CONFLICT_MESSAGE }, { status: 409 })
            : NextResponse.json(
                  { error: "setlist not found" },
                  { status: 404 },
              );
    }

    // Best-effort: refresh the members' shared copy if this set is shared. A sync failure must not
    // fail the break edit, which already succeeded.
    await resyncMemberSnapshot(repo, setlistId).catch(() => {});

    // The resync (when shared) writes draft_order, which bumps the setlist's updated_at PAST the
    // version set_breaks returned — so re-read the current version and hand THAT back. Otherwise the
    // client's next break edit guards on the pre-resync token and false-conflicts every time.
    const meta = await repo.getSetlistMeta(setlistId).catch(() => null);
    return NextResponse.json({
        ok: true,
        version: meta?.version ?? result.version,
    });
}
