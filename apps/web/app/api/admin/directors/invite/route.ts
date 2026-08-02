// POST /api/admin/directors/invite { email, displayName, ensembleName }
//   -> invite a brand-new director and authorize them to found exactly one ensemble.
//
// The perimeter proxy already gates /api/admin/* to platform admins, but this re-checks admin
// server-side (defense in depth — never trust the middleware alone; a matcher gap or a direct call must
// still be refused). Then: rate-limit the admin's director invites, send the invite (sendDirectorInvite
// stamps the pending ensemble name into the invited account's metadata), and grant that account one
// founding credit with the ADMIN's OWN session — grant_founding_credit checks the caller is a platform
// admin (auth.uid()), so it cannot run on the service-role invite client. On accept, /auth/confirm seeds
// the ensemble and consumes the credit.

import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { coerceInviteEmail } from "@/lib/inviteInput";
import { sendDirectorInvite } from "@/lib/invite";

export async function POST(req: Request) {
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user)
        return NextResponse.json(
            { error: "not authenticated" },
            { status: 401 },
        );
    const { data: isAdmin } = await supabase.rpc("auth_is_platform_admin");
    if (isAdmin !== true)
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const raw = (await req.json().catch(() => null)) as Record<
        string,
        unknown
    > | null;
    const parsed = coerceInviteEmail(raw);
    if (!parsed.ok)
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    // Capped at 80 to match the ensemble name limit in lib/ensembleSettingsInput.ts. Both values
    // are stamped into user_metadata, which rides inside the access token on every request, and
    // both reach the invite email, so bound them where they enter rather than at the far end.
    const MAX_NAME = 80;
    const displayName =
        typeof raw?.displayName === "string"
            ? raw.displayName.trim().slice(0, MAX_NAME)
            : "";
    const ensembleName =
        typeof raw?.ensembleName === "string"
            ? raw.ensembleName.trim().slice(0, MAX_NAME)
            : "";
    if (!displayName)
        return NextResponse.json(
            { error: "a director name is required" },
            { status: 400 },
        );
    if (!ensembleName)
        return NextResponse.json(
            { error: "an ensemble name is required" },
            { status: 400 },
        );

    // Rate-limit the admin's director invites (server-defined ceiling; the kind is the only input).
    // Consumed after input validation (a malformed request never burns allowance) but before the send, so
    // the ceiling limits attempts -- a retry or a delivery that fails still counts against the 20/hour.
    const { data: allowed } = await supabase.rpc("consume_invite_quota", {
        p_kind: "director_invite",
    });
    if (allowed !== true) {
        return NextResponse.json(
            {
                error: "Too many director invites in the last hour. Try again later.",
            },
            { status: 429 },
        );
    }

    const result = await sendDirectorInvite(parsed.value, {
        displayName,
        ensembleName,
    });

    if (result.reason === "exists") {
        // The email already has an account (a current member starting their own ensemble). No invite is sent;
        // authorize their existing account by granting a founding credit, and they create the ensemble
        // themselves from Your ensembles. The names typed above are for a new director and are ignored here.
        const { data: granted, error: grantErr } = await supabase.rpc(
            "grant_founding_credit_by_email",
            {
                p_email: parsed.value,
            },
        );
        if (grantErr || granted !== true) {
            return NextResponse.json(
                { error: "Could not authorize that account. Try again." },
                { status: 500 },
            );
        }
        return NextResponse.json({
            ok: true,
            message: `${parsed.value} already has an account, so no invite was sent. They are authorized to found an ensemble now, and can create it from Your ensembles.`,
        });
    }

    if (result.reason !== "sent" || !result.userId) {
        // Delivery failed (misconfiguration or transport). Nothing to grant; surface the reason.
        return NextResponse.json({ error: result.message }, { status: 400 });
    }

    // A new (or unaccepted) account was invited. Authorize exactly one founding with the admin's OWN session
    // (grant_founding_credit checks auth.uid() is a platform admin). The invite email is already out, so a
    // grant failure is not silent. The grant is idempotent, so resubmitting the same email re-sends and
    // finishes authorizing without over-granting -- tell the admin to retry rather than stranding the director.
    const { error: grantErr } = await supabase.rpc("grant_founding_credit", {
        p_user_id: result.userId,
    });
    if (grantErr) {
        return NextResponse.json(
            {
                error: "The invitation was sent, but authorizing the founding credit failed. Submit again to finish authorizing the director.",
            },
            { status: 500 },
        );
    }

    return NextResponse.json({
        ok: true,
        message: `Invitation sent to ${parsed.value}.`,
    });
}
