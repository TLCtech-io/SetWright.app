// GET /auth/confirm?token_hash=...&type=signup|invite|magiclink|recovery|email_change|email
//
// The landing route for every member-invite / sign-in email (the email links here with a
// one-time token_hash — see supabase/templates/*.html). It verifies the token to establish
// a session, then routes the user into the app. It binds no seat: an invitation is accepted by
// the person named on it, at /auth/invitations, so verifying a link proves the address and nothing
// more. A brand-new invited account has no password yet, so it goes to /auth/welcome to set one;
// an account that already had a password goes straight in.
//
// This is the canonical @supabase/ssr server-side flow: verifyOtp on a request-scoped
// server client writes the session cookies onto the redirect response. It is identical for
// local dev (GoTrue emails captured in Mailpit) and production (the Resend Send Email Hook).

import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { confirmDestination } from "@/lib/confirmDest";
import { pendingSeedApplies } from "@/lib/confirmSeed";

// GoTrue's EmailOtpType ends in `(string & {})`, so casting a query param to it typechecks any
// string at all and hands it straight to verifyOtp. Narrow against the real member list instead.
// These are every type the templates emit (signup, invite, magiclink, recovery, email_change)
// plus email, which confirmDestination accepts so a link built with the generic type still routes
// to the profile. An unrecognised type now takes the same path an absent one does.
const OTP_TYPES = [
    "signup",
    "invite",
    "magiclink",
    "recovery",
    "email_change",
    "email",
] as const satisfies readonly EmailOtpType[];

function otpType(value: string | null): (typeof OTP_TYPES)[number] | null {
    return OTP_TYPES.find((t) => t === value) ?? null;
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const token_hash = url.searchParams.get("token_hash");
    const type = otpType(url.searchParams.get("type"));

    if (token_hash && type) {
        const supabase = await serverClient();
        const { data: verified, error } = await supabase.auth.verifyOtp({
            type,
            token_hash,
        });
        if (!error) {
            // Nothing binds a seat here any more. Verifying a link proves the address; it does not
            // say the person wants to join. This route used to call claim_membership on every
            // confirm of any type, which meant a director who knew an address could put its owner in
            // their ensemble the next time that person clicked a magic link or reset a password. The
            // decision moved to /auth/invitations, and until it is made no membership exists.
            //
            // So `first` is only ever the ensemble a NEW DIRECTOR seeds below, never a claimed seat.
            let first: string | null = null;

            // Onboarding metadata is consumed at this point and must not linger: user_metadata
            // rides inside the access token on every request, so an invited singer would otherwise
            // carry their ensemble's name in their JWT forever. invite_kind and the two invited_*
            // keys only ever shaped the invite email; pending_ensemble_name is cleared by whichever
            // seed branch below consumed it. One call, tracked so no branch clears twice.
            let cleared = false;
            const clearOnboardingMetadata = async () => {
                if (cleared) return;
                cleared = true;
                await supabase.auth.updateUser({
                    data: {
                        pending_ensemble_name: null,
                        invite_kind: null,
                        invited_ensemble_name: null,
                        invited_by_name: null,
                    },
                });
            };

            // A pending_ensemble_name in the verified user's metadata means "seed this ensemble on confirm."
            // Two on-ramps set it: a brand-new director typing their name at /signup (the create is deferred
            // because there is no session until they confirm), and an admin's director invite (sendDirectorInvite
            // stamps it, so accepting the invite creates the ensemble and consumes the founding credit the admin
            // granted). Honor it now that verifyOtp has established a session. A member invite carries no pending
            // name and a recovery link never seeds, so pendingSeedApplies gates on that; the second, independent
            // guard below ("does not already direct an ensemble") stops a re-run or a returning sign-in from
            // spinning up a duplicate. On any failure, fall through so they can create it by hand.
            const user = verified.user;
            const pendingName = (
                user?.user_metadata?.pending_ensemble_name as string | undefined
            )?.trim();
            if (user && pendingSeedApplies(type, pendingName)) {
                // Create the ensemble the new director typed at /signup — EVEN IF this address was also
                // invited elsewhere. Dropping the typed name because someone happened to invite them
                // silently loses what they asked for; instead they get both (their own ensemble now, and
                // any invitation still waiting for them to accept). Guard on "does not already DIRECT an
                // ensemble" (not "has no membership at all"), so an accepted member seat does not suppress
                // the create, while a returning director never spins up a second one. Clear the name
                // afterward so a later sign-in never recreates it.
                const { data: directed } = await supabase
                    .from("member")
                    .select("ensemble_id")
                    .eq("user_id", user.id)
                    .eq("permission_tier", "director")
                    .eq("status", "active")
                    .limit(1);
                if (!directed || directed.length === 0) {
                    const displayName =
                        (user.user_metadata?.display_name as
                            | string
                            | undefined) ??
                        user.email?.split("@")[0] ??
                        "Director";
                    const { data: seededId, error: seedErr } =
                        await supabase.rpc("create_ensemble_seeded", {
                            p_name: pendingName,
                            p_display_name: displayName,
                        });
                    if (seedErr || !seededId) {
                        console.error(
                            "[signup] create_ensemble_seeded failed after confirm:",
                            seedErr?.message,
                        );
                    } else {
                        first = seededId as string; // land on the ensemble they just created (their signup intent)
                        // Clear the pending name so a later magic-link or sign-in never recreates it.
                        await clearOnboardingMetadata();
                    }
                } else {
                    // Already directs an ensemble, but a stale pending name lingered from an earlier flow —
                    // clear it so it stops re-firing on every future sign-in.
                    await clearOnboardingMetadata();
                }
            }

            // The seed path did not run (a member invite, a magic link, a recovery), so nothing has
            // cleared the invite keys yet. Only write when there is something to clear, so an
            // ordinary sign-in does not issue a pointless user update on every confirm.
            const meta: Record<string, unknown> = user?.user_metadata ?? {};
            if (
                user &&
                (meta["invite_kind"] ||
                    meta["invited_ensemble_name"] ||
                    meta["invited_by_name"])
            ) {
                await clearOnboardingMetadata();
            }

            // Resolve the ensemble uuid to its URL token: the app is addressed by public_id, so the
            // ?e param (read by /auth/welcome) and the dashboard redirect both carry the token, never the
            // uuid. The user is now a member, so ensemble_read authorizes this point lookup.
            let firstToken: string | null = null;
            if (first) {
                const { data: ens } = await supabase
                    .from("ensemble")
                    .select("public_id")
                    .eq("id", first)
                    .maybeSingle();
                firstToken = (ens?.public_id ?? null) as string | null;
            }

            // An email-change confirm binds no seat (the member is already bound), so `first` stays null.
            // Resolve their own active ensemble so confirmDestination can land them back on their profile
            // rather than the generic home resolver. Any ensemble works: the email is account-wide, so the
            // profile shows the same address whichever ensemble frames it.
            if (
                !firstToken &&
                (type === "email" || type === "email_change") &&
                user
            ) {
                const { data: mine } = await supabase
                    .from("member")
                    .select("ensemble_id")
                    .eq("user_id", user.id)
                    .eq("status", "active")
                    .limit(1)
                    .maybeSingle();
                if (mine?.ensemble_id) {
                    const { data: ens } = await supabase
                        .from("ensemble")
                        .select("public_id")
                        .eq("id", mine.ensemble_id)
                        .maybeSingle();
                    firstToken = (ens?.public_id ?? null) as string | null;
                }
            }

            // Is there a decision waiting? Only asked for the link types that are about arriving. A
            // recovery or an email change is someone doing an unrelated task, and derailing that with
            // a join prompt is exactly what this flow avoids; their invitation keeps.
            let hasPendingInvitations = false;
            if (
                type !== "recovery" &&
                type !== "email" &&
                type !== "email_change"
            ) {
                const { data: pending, error: pendingErr } = await supabase.rpc(
                    "list_pending_invitations",
                );
                if (pendingErr) {
                    // Not fatal: the session is valid either way, so route them on rather than 500.
                    // They can reach /auth/invitations directly and the list runs again there.
                    console.error(
                        "[invitations] list_pending_invitations failed after verifyOtp:",
                        pendingErr.message,
                    );
                }
                hasPendingInvitations = Array.isArray(pending)
                    ? pending.length > 0
                    : false;
            }

            // invite/recovery established a session without a usable password, so send them to set one;
            // magic-link and signup (which already chose a password at sign-up) go straight in. See
            // confirmDestination (extracted + unit-tested).
            const dest = confirmDestination(
                type,
                firstToken,
                hasPendingInvitations,
            );
            return NextResponse.redirect(new URL(dest, url.origin));
        }
    }

    return NextResponse.redirect(new URL("/auth/auth-error", url.origin));
}
