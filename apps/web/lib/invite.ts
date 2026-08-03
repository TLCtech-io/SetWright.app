// Server-only delivery of the member-invite email. The seat's invite_email is recorded
// separately (repo.inviteMember, RLS-gated to the director); this just sends the auth
// email the invitee clicks to claim it. NEVER import from client code — it builds the
// service-role admin client.
//
// Two paths, by whether the address already has an account:
//   - new address      -> auth.admin.inviteUserByEmail: GoTrue creates the (unconfirmed)
//                         user and emails an invite link.
//   - existing account -> a magic-link sign-in (signInWithOtp, shouldCreateUser:false),
//                         since you cannot "invite" an account that already exists.
// Either email links to /auth/confirm, which verifies the token, runs claim_membership(),
// and binds the seat. Locally GoTrue captures the email in Mailpit (:54324); in production
// the Send Email Hook renders + delivers it through Resend (see supabase/functions/send-email/index.ts).

import { createClient } from "@supabase/supabase-js";
import { dataSource, supabaseAnonKey, supabaseUrl } from "./env";
import { adminClient } from "./supabase/admin";

export interface InviteDelivery {
    delivered: boolean;
    message: string;
}

/** What the invite email is allowed to say about where the seat is. Display only: the email
 *  renderer reads these, nothing else does. Both are optional, and the email has copy for the
 *  case where neither is present. */
export interface MemberInviteContext {
    /** The ensemble the seat belongs to. */
    ensembleName?: string;
    /** The inviting director's display name. */
    invitedByName?: string;
}

/** Matches the cap ensembleSettingsInput.ts applies to an ensemble name. Metadata rides inside
 *  the user's JWT on every request, so it is worth bounding at the point it is written. */
const MAX_META_NAME = 80;

function clip(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, MAX_META_NAME);
}

function alreadyRegistered(message: string): boolean {
    return /already.*(registered|exist)|email_exists|been registered/i.test(
        message,
    );
}

/**
 * Deliver the invite/sign-in email for `email`. The link lands on /auth/confirm, which verifies the
 * GoTrue OTP and then binds the seat invited under this now-VERIFIED address (claim_membership matches
 * member.invite_email to auth.email()). No per-seat bearer token rides in the user's readable
 * metadata anymore, so there is nothing to lift before the claim. In mock mode there is no auth
 * backend, so nothing is sent — the seat is still recorded.
 *
 * `ctx` only shapes what the email says. It is stamped as user_metadata so the Send Email hook can
 * name the group, and it is deliberately NOT pending_ensemble_name: /auth/confirm reads that exact
 * key to seed a new ensemble on a type=invite link, so reusing it here would spin one up for an
 * invited singer. The resend route passes no ctx and does not need to: GoTrue applies invite data
 * only when it creates the user, so a re-invite leaves the original metadata in place.
 */
export async function sendMemberInvite(
    email: string,
    ctx: MemberInviteContext = {},
): Promise<InviteDelivery> {
    if (dataSource !== "supabase") {
        return {
            delivered: false,
            message: "Invite recorded. No email is sent in mock mode.",
        };
    }

    const ensembleName = clip(ctx.ensembleName);
    const invitedByName = clip(ctx.invitedByName);

    try {
        const admin = adminClient();
        // New account: GoTrue creates the (unconfirmed) user and emails a standard invite link.
        // invite_kind is the positive marker the email branches on. It must be a marker of its own
        // rather than "has an ensemble name", because a self-signup account that never confirmed
        // still carries pending_ensemble_name and can still be invited to someone else's seat.
        const { error } = await admin.auth.admin.inviteUserByEmail(email, {
            data: {
                invite_kind: "member",
                ...(ensembleName
                    ? { invited_ensemble_name: ensembleName }
                    : {}),
                ...(invitedByName ? { invited_by_name: invitedByName } : {}),
            },
        });
        if (!error)
            return { delivered: true, message: "Invitation email sent." };

        if (alreadyRegistered(error.message)) {
            // Existing account: you cannot "invite" an existing user, so send a magic-link sign-in. Either
            // email lands on /auth/confirm, which binds the seat invited under this verified address.
            // The success message matches the new-account branch on purpose: a distinct message would
            // let any director probe which emails already hold accounts (enumeration).
            //
            // Note what this means when the caller is the unauthenticated resend route: a third party
            // can cause a live sign-in link to be mailed to someone else's address. It is bounded and
            // it is intended. The link only ever goes TO the address it signs in, only for an address
            // that already holds a pending seat in an active ensemble, and at most 3 times an hour.
            // It is also necessary: claim_membership runs from exactly one place, /auth/confirm, so
            // an invitee who already has an account has no other way to bind their seat. Removing it
            // would strand them, not protect them.
            const anon = createClient(supabaseUrl, supabaseAnonKey, {
                auth: { persistSession: false },
            });
            const { error: otpErr } = await anon.auth.signInWithOtp({
                email,
                options: { shouldCreateUser: false },
            });
            if (!otpErr) {
                return { delivered: true, message: "Invitation email sent." };
            }
            return {
                delivered: false,
                message: `Seat recorded, but the email could not be sent: ${otpErr.message}`,
            };
        }

        return {
            delivered: false,
            message: `Seat recorded, but the email could not be sent: ${error.message}`,
        };
    } catch {
        // Any construction/transport failure lands here — most notably a missing SUPABASE_SERVICE_ROLE_KEY,
        // which makes adminClient() throw. The seat is already recorded, so report an undelivered send
        // rather than 500ing the whole invite (which would mislead: the seat and email WERE stored).
        return {
            delivered: false,
            message:
                "Seat recorded, but the email could not be sent (email delivery is not configured).",
        };
    }
}

export interface DirectorInviteResult extends InviteDelivery {
    /** The invited (newly created) auth user's id, so the caller can grant it a founding credit. Null when
     *  no user was created (mock mode, an existing account, or a failed send). */
    userId: string | null;
    /** How to onboard: 'sent' = a new (or unconfirmed) account was invited, grant by userId; 'exists' = the
     *  email already has a confirmed account (a current member starting their own ensemble), grant by email
     *  and let them self-create; 'failed' = nothing happened. */
    reason: "sent" | "exists" | "failed";
}

/**
 * Deliver a DIRECTOR invite: the admin-issued on-ramp for a brand-new director. Unlike sendMemberInvite,
 * it stamps the metadata /auth/confirm reads to seed the new ensemble — display_name for the director's
 * member row, pending_ensemble_name for create_ensemble_seeded. Returns the created user's id so the
 * caller (the admin route) can grant that user a founding credit with its OWN admin session:
 * grant_founding_credit checks the CALLER is a platform admin, so it cannot run on this service-role
 * client. An existing account cannot be invited, and stamping onboarding onto one is a separate flow
 * (a later seam), so we report it plainly — the admin UI is platform-admin only, so the enumeration
 * concern that shapes sendMemberInvite's messages does not apply here.
 */
export async function sendDirectorInvite(
    email: string,
    opts: { displayName: string; ensembleName: string },
): Promise<DirectorInviteResult> {
    if (dataSource !== "supabase") {
        return {
            delivered: false,
            userId: null,
            reason: "failed",
            message: "Invite recorded. No email is sent in mock mode.",
        };
    }

    try {
        const admin = adminClient();
        const { data, error } = await admin.auth.admin.inviteUserByEmail(
            email,
            {
                data: {
                    invite_kind: "director",
                    display_name: clip(opts.displayName),
                    pending_ensemble_name: clip(opts.ensembleName),
                },
            },
        );
        if (!error && data?.user) {
            return {
                delivered: true,
                userId: data.user.id,
                reason: "sent",
                message: "Director invitation sent.",
            };
        }
        if (error && alreadyRegistered(error.message)) {
            // A confirmed account already holds this email (a current member). No invite to send; the caller
            // authorizes their existing account by email instead.
            return {
                delivered: false,
                userId: null,
                reason: "exists",
                message: "That email already has an account.",
            };
        }
        return {
            delivered: false,
            userId: null,
            reason: "failed",
            message: `The invitation could not be sent: ${error?.message ?? "unknown error"}`,
        };
    } catch {
        return {
            delivered: false,
            userId: null,
            reason: "failed",
            message:
                "The invitation could not be sent (email delivery is not configured).",
        };
    }
}
