// POST /api/e/:ensembleId/members/:id/invite { email }
//   -> record the email a pending seat is invited under (RLS-gated to the director) and
//      send the invitee a Supabase auth email to claim it. Re-POSTing resends.
//
// The record (repo.inviteMember) and the send (sendMemberInvite) are separate: the seat
// is stored first, so even if delivery fails the director can resend without re-entering
// the address. Delivery only happens in supabase mode; mock mode records the seat and
// says no email was sent.

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";
import { coerceInviteEmail } from "@/lib/inviteInput";
import { sendMemberInvite } from "@/lib/invite";
import { dataSource } from "@/lib/env";
import { serverClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

const STATUS: Record<string, number> = {
    not_found: 404,
    claimed: 409,
    duplicate: 409,
    forbidden: 403,
};
const MESSAGE: Record<string, string> = {
    not_found: "member not found",
    claimed: "that seat has already been claimed",
    duplicate: "that email is already invited to another seat",
    forbidden: "only a director can invite members",
};

export async function POST(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;

    const raw = await req.json().catch(() => null);
    const parsed = coerceInviteEmail(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });

    // A per-seat token hash is still recorded on the seat as a dormant second factor, but the claim now
    // binds by the invitee's GoTrue-VERIFIED email, not by presenting this token — so nothing has
    // to carry a readable bearer to the inbox. Kept populated in case a token factor is re-enabled.
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const result = await repo.inviteMember(id, parsed.value, tokenHash);
    if (!result.ok) {
        // A dead-end invite: the email already holds a seat here. Name the person and steer the director
        // to reactivation (for a removed seat) rather than recording an invite that can never bind.
        if (result.reason === "already_member") {
            return NextResponse.json(
                {
                    error: `${result.memberName} is already an active member with this email, so no invite is needed.`,
                },
                { status: 409 },
            );
        }
        if (result.reason === "removed_member") {
            return NextResponse.json(
                {
                    error: `This email belongs to ${result.memberName}, who was removed from this ensemble. Reactivate their seat from the roster instead of inviting a new one.`,
                    reactivate: true,
                },
                { status: 409 },
            );
        }
        return NextResponse.json(
            { error: MESSAGE[result.reason] },
            { status: STATUS[result.reason] },
        );
    }

    // Rate-limit the director's invite emails (server-defined ceiling) before sending, so the invite/resend
    // button cannot be turned into an email-amplification vector. The seat is already recorded, so a
    // throttled director keeps the seat and can resend once the window clears. Mock mode has no RPC.
    if (dataSource === "supabase") {
        const supabase = await serverClient();
        const { data: allowed } = await supabase.rpc("consume_invite_quota", {
            p_kind: "member_invite",
        });
        if (allowed !== true) {
            return NextResponse.json(
                {
                    error: "Too many invites in the last hour. The seat is saved; resend later.",
                },
                { status: 429 },
            );
        }
    }

    // Name the group in the invite email. Read through the RLS-scoped repo, never the
    // service-role client, which does no tenant reads. This only shapes copy, so a lookup
    // failure degrades to the generic wording rather than costing the director a delivery.
    let ensembleName: string | undefined;
    try {
        ensembleName = (await repo.getEnsembleSettings()).name;
    } catch (e) {
        console.error("[invite] could not read the ensemble name:", e);
    }

    const delivery = await sendMemberInvite(parsed.value, { ensembleName });
    return NextResponse.json({
        ok: true,
        email: parsed.value,
        delivered: delivery.delivered,
        message: delivery.message,
    });
}
