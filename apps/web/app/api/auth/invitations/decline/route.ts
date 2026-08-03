// POST /api/auth/invitations/decline { ensembleId } -> refuse the invitation from that ensemble.
//
// Declining keeps the member_invite row and stamps declined_at, so the director sees the outcome on
// the roster rather than an invitation that still looks like it is waiting. The seat itself stays
// unclaimed and can be re-invited. Nothing re-offers a declined row: the invitation list, the bind,
// and the unauthenticated resend path all skip it.
//
// Same gate as accept: keyed on auth.email(), under /api so the proxy's 401 and the CSRF check apply.

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

    const { data: declined, error } = await supabase.rpc(
        "decline_invitation",
        { p_ensemble: parsed.value },
    );
    if (error) {
        console.error(
            "[invitations] decline_invitation failed:",
            error.message,
        );
        return NextResponse.json(
            { error: "could not decline this invitation" },
            { status: 500 },
        );
    }
    if (declined !== true)
        return NextResponse.json(
            { error: "that invitation is no longer available" },
            { status: 409 },
        );

    return NextResponse.json({ ok: true });
}
