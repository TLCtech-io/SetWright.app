// POST /api/ensembles/create {name} -> create a new, fully-seeded ensemble (the caller
// becomes its director) and make it the active one. Wraps create_ensemble_seeded, the
// transactional onboarding routine.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
    ACTIVE_ENSEMBLE_COOKIE,
    ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
} from "@/lib/ensemble";
import { serverClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
    // A literal `null` body is valid JSON, so the catch never fires; coalesce it (and a non-string
    // name) rather than dereferencing null / calling .trim() on a number, which would 500.
    const body = (await req.json().catch(() => null)) as {
        name?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name)
        return NextResponse.json(
            { error: "an ensemble name is required" },
            { status: 400 },
        );

    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user)
        return NextResponse.json(
            { error: "not authenticated" },
            { status: 401 },
        );

    const displayName =
        (user.user_metadata?.display_name as string | undefined) ??
        user.email?.split("@")[0] ??
        "Director";
    const { data, error } = await supabase.rpc("create_ensemble_seeded", {
        p_name: name,
        p_display_name: displayName,
    });
    if (error || !data) {
        // The founding guards raise user-facing messages; surface them so the director learns the actual
        // reason instead of retrying against a generic 500. Any other failure stays opaque.
        if (error?.message?.includes("maximum number of ensembles")) {
            return NextResponse.json(
                {
                    error: "You already direct the maximum number of ensembles.",
                },
                { status: 409 },
            );
        }
        // No founding credit (invite-first): a plain member cannot self-create. Say so, instead of a 500.
        if (error?.message?.includes("not authorized to found an ensemble")) {
            return NextResponse.json(
                {
                    error: "Creating a new ensemble needs an invitation. Contact us for access.",
                },
                { status: 403 },
            );
        }
        return NextResponse.json(
            { error: "could not create the ensemble" },
            { status: 500 },
        );
    }

    const ensembleId = data as string;
    // The client navigates to /e/:publicId, so hand back the new ensemble's URL token alongside the
    // uuid. The caller is now its director, so ensemble_read authorizes this point lookup. The cookie
    // stays the uuid (tenancy scoping is uuid-based; only the URL segment is a token).
    const { data: created } = await supabase
        .from("ensemble")
        .select("public_id")
        .eq("id", ensembleId)
        .maybeSingle();
    (await cookies()).set(
        ACTIVE_ENSEMBLE_COOKIE,
        ensembleId,
        ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
    );
    return NextResponse.json({
        id: ensembleId,
        publicId: (created?.public_id ?? null) as string | null,
    });
}
