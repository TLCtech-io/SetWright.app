// GET  /api/e/:ensembleId/setlist/:id        -> current draft + pins + catalog
// POST /api/e/:ensembleId/setlist/:id  {pins} -> set the pins, re-draft, return the same shape
//
// Setting pins is the only write. In the mock it mutates the in-memory store;
// under Supabase it becomes a setlist_item upsert. The re-draft then runs through
// draftSetForSetlist exactly as a fresh load would.

import { NextResponse } from "next/server";
import type { VarietyConfig } from "@repertoire/core";
import { loadSetlist, loadFrozenSnapshot } from "@/lib/setlist";
import { resyncMemberSnapshot } from "@/lib/sharedDraft";
import { getMyMembership } from "@/lib/ensembles";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceIdList } from "@/lib/limits";
import type { SetlistStatus } from "@/lib/db";
import type { PinState } from "@/lib/types";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

export async function GET(_req: Request, { params }: Params) {
    // loadSetlist reads notes/transitions/performed-order through the repo, so it must be the
    // URL's ensemble (not the shared cookie). repoForRoute also validates membership.
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;

    // A member may read a setlist (RLS scopes it to published/performed/shared sets); only the writes
    // below are director-only. So this GET stays ungated while POST/PATCH/DELETE require director.
    const repo = await repoForRoute(ensembleId);
    if (repo instanceof NextResponse) return repo;

    // Directors get the live, editable draft. A member must NEVER run the drafter: it would expose
    // the bench, the drops and the shortfall, which are the director's working state and are
    // computed rather than stored. Members read the frozen snapshot instead (performed or published
    // order, or a shared live draft). Note what is NOT the reason: the event pool itself, meaning
    // RSVPs and who covers which part, is peer-visible by design.
    const me = await getMyMembership(ensembleId);
    const res =
        me?.tier === "director"
            ? await loadSetlist(repo, setlistId)
            : await loadFrozenSnapshot(repo, setlistId);
    return NextResponse.json(res.body, { status: res.status });
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coercePins(raw: unknown): PinState {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
        string,
        unknown
    >;
    // A pin id must be a well-formed uuid. A stray string or wrong type drops to null/omitted rather
    // than reaching set_pins' uuid-typed params (a non-uuid there aborts the RPC as a 500). A valid
    // but unknown id still rolls back safely on the FK. keep/excluded are also capped (coerceIdList)
    // so a pathological pin list can't balloon the redraft.
    const uuid = (v: unknown): string | null =>
        typeof v === "string" && UUID_RE.test(v) ? v : null;
    const uuids = (v: unknown): string[] =>
        coerceIdList(v).filter((id) => UUID_RE.test(id));
    return {
        open: uuid(r.open),
        close: uuid(r.close),
        keep: uuids(r.keep),
        excluded: uuids(r.excluded),
    };
}

// Variety is optional; a finite seed and a non-negative amount, or nothing (a
// deterministic re-draft). It is transient request input, not a stored pin.
function coerceVariety(raw: unknown): VarietyConfig | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.seed !== "number" || !Number.isFinite(r.seed))
        return undefined;
    const amount = typeof r.amount === "number" && r.amount > 0 ? r.amount : 0;
    if (amount === 0) return undefined; // amount 0 is just the deterministic draft
    return { seed: r.seed, amount };
}

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    // Pins + re-draft mutate the set — a performed or finalized set is locked.
    const lock = await repo.setlistLockReason(setlistId);
    if (lock) {
        return NextResponse.json({ error: lock }, { status: 409 });
    }
    // A literal `null` body is valid JSON, so coalesce the parsed value before reading a field.
    const body = ((await req.json().catch(() => null)) ?? {}) as {
        pins?: unknown;
        variety?: unknown;
    };
    await repo.setPins(setlistId, coercePins(body.pins));

    // A redraft (pin change or Re-generate) supersedes any manual arrangement: clear it so the
    // canonical order takes over. The director re-arranges from the fresh order if they want.
    await repo.setArrangedOrder(setlistId, null);
    const variety = coerceVariety(body.variety);
    const res = await loadSetlist(repo, setlistId, variety);

    // If this set is member-visible (published or shared), keep the members' copy on the CANONICAL
    // draft. resyncMemberSnapshot re-loads without variety, so it captures the director's committed set
    // (the persisted pins), never this response's exploratory reroll — and it runs on every pin change,
    // even one that rode in with a variety seed. Best-effort: the pin edit already committed above, so a
    // sync hiccup must not fail this request.
    await resyncMemberSnapshot(repo, setlistId).catch(() => {});
    return NextResponse.json(res.body, { status: res.status });
}

// 'performed' is reached only by performing (which freezes an order), never set here.
const SETTABLE: SetlistStatus[] = ["draft", "final"];

// PATCH /api/e/:ensembleId/setlist/:id {name?, status?} -> rename or change status
export async function PATCH(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    // A literal `null` body is valid JSON, so coalesce the parsed value before reading a field.
    const body = ((await req.json().catch(() => null)) ?? {}) as {
        name?: unknown;
        status?: unknown;
    };
    const patch: { name?: string | null; status?: SetlistStatus } = {};
    if (typeof body.name === "string") patch.name = body.name.trim() || null;
    if (SETTABLE.includes(body.status as SetlistStatus))
        patch.status = body.status as SetlistStatus;
    const updated = await repo.updateSetlist(setlistId, patch);
    if (!updated) {
        // updateSetlist refuses a performed set (immutable); tell that apart from missing.
        if (await repo.getSetlistMeta(setlistId)) {
            return NextResponse.json(
                { error: "a performed set is read-only" },
                { status: 409 },
            );
        }
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({ id: updated.id });
}

// DELETE /api/e/:ensembleId/setlist/:id -> remove this setlist (a performed set is read-only)
export async function DELETE(_req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const result = await repo.deleteSetlist(setlistId);
    if (!result.ok) {
        if (result.reason === "performed") {
            return NextResponse.json(
                { error: "a performed set is read-only" },
                { status: 409 },
            );
        }
        return NextResponse.json(
            { error: "setlist not found" },
            { status: 404 },
        );
    }
    return NextResponse.json({ ok: true });
}
