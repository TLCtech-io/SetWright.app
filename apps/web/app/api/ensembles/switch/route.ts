// POST /api/ensembles/switch {ensembleId} -> set the active-ensemble cookie.
// The membership check is belt-and-suspenders: the repository re-validates the cookie
// against the user's memberships anyway, so a stale/forged value can never leak data.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
    ACTIVE_ENSEMBLE_COOKIE,
    ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
} from "@/lib/ensemble";
import { listMyEnsembles } from "@/lib/ensembles";

export async function POST(req: Request) {
    // A literal `null` body is valid JSON, so the catch never fires; coalesce it (and a non-string
    // ensembleId) rather than dereferencing null, which would 500.
    const body = (await req.json().catch(() => null)) as {
        ensembleId?: unknown;
    } | null;
    const id = typeof body?.ensembleId === "string" ? body.ensembleId : "";
    const mine = await listMyEnsembles();
    if (!id || !mine.some((e) => e.id === id)) {
        return NextResponse.json(
            { error: "not a member of that ensemble" },
            { status: 403 },
        );
    }
    (await cookies()).set(
        ACTIVE_ENSEMBLE_COOKIE,
        id,
        ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
    );
    return NextResponse.json({ ok: true });
}
