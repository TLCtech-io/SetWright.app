// POST /api/auth/invitations/accept { ensembleId } -> join the ensemble that invited this address.
//
// The consent step. Nothing binds a seat to an account without this call (or its decline twin): the
// confirm route no longer claims anything on the invitee's behalf. accept_invitation keys on
// auth.email(), so ensembleId only narrows which of the caller's own invitations to act on and can
// never reach someone else's.
//
// Under /api, so the proxy's 401 gate and the CSRF origin check both cover it. It is deliberately NOT
// in the proxy's public allowlist, which matches only /api/auth/resend by exact string.

import { NextResponse } from "next/server";
import { coerceInvitationTarget } from "@/lib/invitationInput";
import { serverClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
    const parsed = coerceInvitationTarget(await req.json().catch(() => null));
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });

    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user)
        return NextResponse.json(
            { error: "not authenticated" },
            { status: 401 },
        );

    const { data: accepted, error } = await supabase.rpc("accept_invitation", {
        p_ensemble: parsed.value,
    });
    if (error) {
        console.error("[invitations] accept_invitation failed:", error.message);
        return NextResponse.json(
            { error: "could not accept this invitation" },
            { status: 500 },
        );
    }
    // False means nothing eligible matched: already accepted, declined, expired, or never addressed to
    // this account. Report it rather than returning a success the screen would render as "you're in".
    if (accepted !== true)
        return NextResponse.json(
            { error: "that invitation is no longer available" },
            { status: 409 },
        );

    // The token, not the uuid: every console URL is addressed by public_id. The caller is a member as
    // of the line above, so ensemble_read authorizes this lookup. The caller sends everyone to the
    // dashboard and lets the proxy bounce a non-director to their own space, which is the same thing
    // confirmDestination does rather than branching on tier here.
    const { data: ens } = await supabase
        .from("ensemble")
        .select("public_id")
        .eq("id", parsed.value)
        .maybeSingle();

    return NextResponse.json({
        ok: true,
        ensembleToken: (ens?.public_id ?? null) as string | null,
    });
}
