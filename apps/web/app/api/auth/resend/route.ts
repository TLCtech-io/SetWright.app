// POST /api/auth/resend { email } -> re-send a member invitation to an address that has a PENDING seat.
//
// Unauthenticated: it is the self-serve recovery for a member whose invite link expired, so it is
// carefully bounded. (1) Rate-limited per address (the 'resend' ceiling, 3/hour). (2) It sends ONLY when a
// pending seat actually exists (refresh_pending_invite, via the service-role client), which also renews the
// seat so the fresh link binds even if it had aged out -- never an open relay to arbitrary inboxes. (3) It
// ALWAYS returns the same message and sends the email AFTER the response (via after()), so neither the body,
// the status, nor the response latency reveals whether the address has a pending invite -- enumeration-safe.
// Failures are logged server-side (never reaching the client) so a misconfig is not a silent false success.

import { after, NextResponse } from "next/server";
import { dataSource } from "@/lib/env";
import { coerceInviteEmail } from "@/lib/inviteInput";
import { adminClient } from "@/lib/supabase/admin";
import { sendMemberInvite } from "@/lib/invite";

const SAME_MESSAGE =
    "If that address has a pending invitation, we have sent it a fresh link. Check your email.";

export async function POST(req: Request) {
    const parsed = coerceInviteEmail(await req.json().catch(() => null));

    // A malformed email, a throttled address, or an address with no pending seat all return the same
    // message. Mock mode sends nothing.
    if (parsed.ok && dataSource === "supabase") {
        try {
            const admin = adminClient();
            const { data: allowed, error: quotaErr } = await admin.rpc(
                "consume_invite_quota_by_email",
                {
                    p_email: parsed.value,
                    p_kind: "resend",
                },
            );
            if (quotaErr)
                console.error(
                    "[resend] consume_invite_quota_by_email failed:",
                    quotaErr.message,
                );
            if (allowed === true) {
                const { data: pending, error: pendErr } = await admin.rpc(
                    "refresh_pending_invite",
                    {
                        p_email: parsed.value,
                    },
                );
                if (pendErr)
                    console.error(
                        "[resend] refresh_pending_invite failed:",
                        pendErr.message,
                    );

                // Send AFTER the response so the pending and non-pending paths take the same wall-clock time: the
                // outbound email round trip is the only large latency difference, and moving it past the response
                // closes the timing oracle. The seat was renewed above, so the emailed link binds on accept.
                if (pending === true) {
                    after(() =>
                        sendMemberInvite(parsed.value).catch((e) =>
                            console.error("[resend] send failed:", e),
                        ),
                    );
                }
            }
        } catch (e) {
            // Log server-side (this never reaches the client, so enumeration-safety holds) so a misconfig -- a
            // missing service-role key, an unapplied migration -- is not silently swallowed as a false success.
            console.error("[resend] error:", e);
        }
    }
    return NextResponse.json({ ok: true, message: SAME_MESSAGE });
}
