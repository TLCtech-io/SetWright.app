// Every word of every auth email, as data.
//
// Nine messages across six GoTrue action types. The *_shared kinds are the ones the Go
// templates in supabase/templates/ render, so their copy has to read correctly for every
// arrival that shares a template slot. The specific kinds are for the Send Email hook,
// which can read user_metadata and knows which arrival it is looking at.
//
// Rules this copy is held to, enforced by packages/db/test/authEmail.test.ts:
//   - No em dash and no en dash, anywhere.
//   - No duration is ever stated. otp_expiry is set in supabase/config.toml for the local
//     stack only; config push is forbidden, so the hosted expiry is whatever the dashboard
//     says and this repo cannot see it. Say "expires", never "expires in an hour".
//   - Never promise behaviour the code does not implement.
//
// Values interpolated here arrive as plain text and are escaped by shell.ts at render.

/** Which of the nine messages to render. */
export type EmailKind =
    | "invite_shared"
    | "invite_member"
    | "invite_director"
    | "magiclink"
    | "recovery"
    | "signup"
    | "email_change_shared"
    | "email_change_current"
    | "email_change_new";

export const EMAIL_KINDS: readonly EmailKind[] = [
    "invite_shared",
    "invite_member",
    "invite_director",
    "magiclink",
    "recovery",
    "signup",
    "email_change_shared",
    "email_change_current",
    "email_change_new",
];

/** The values a message can interpolate. All optional: every kind has a copy branch for absent. */
export interface CopyVars {
    /** The ensemble a seat belongs to, or the one a new director is being set up to run. */
    ensembleName?: string;
    /** The inviting director's display name. */
    invitedByName?: string;
    /** The invited director's own display name. */
    displayName?: string;
    /** The address currently on the account, during an email change. */
    currentEmail?: string;
    /** The address being moved to, during an email change. */
    nextEmail?: string;
    /** Whether the email change needs both addresses to confirm. */
    dualConfirm?: boolean;
}

export interface EmailCopy {
    /** The `type` value on the /auth/confirm link. Several kinds share one. */
    linkType: string;
    subject: string;
    /** The hidden preview line most clients show next to the subject. */
    preheader: string;
    eyebrow: string;
    heading: string;
    /** Body paragraphs, in order. */
    body: string[];
    /** An optional callout above the button. Used to name the ensemble and the inviter. */
    panel?: string[];
    button: string;
    finePrint: string;
    expiry: string;
}

const IGNORE =
    "If you were not expecting this, you can ignore this email. Without this link, nobody can sign in as you.";
const EXPIRES_NEUTRAL =
    "Links expire, and can only be used once. If this one no longer works, open it anyway and the page will tell you what to do next.";
const EXPIRES_RESEND =
    "Links expire, and can only be used once. If this one no longer works, open it anyway and the page will offer to send you a fresh one.";
const EXPIRES_PLAIN = "Links expire, and can only be used once.";

const WHAT_SETWRIGHT_IS =
    "SetWright is the tool vocal groups use to keep their repertoire straight and draft setlists the group can actually sing.";

export function copyFor(kind: EmailKind, v: CopyVars = {}): EmailCopy {
    const ensemble = v.ensembleName?.trim() || "";
    const inviter = v.invitedByName?.trim() || "";
    const name = v.displayName?.trim() || "";
    const current = v.currentEmail?.trim() || "";
    const next = v.nextEmail?.trim() || "";

    switch (kind) {
        // One body for both invite arrivals: a director inviting a singer to a seat, and a
        // platform admin setting up a brand-new director. The Go surface cannot tell them
        // apart, so it leads on the action rather than the role.
        case "invite_shared":
            return {
                linkType: "invite",
                subject: "Your SetWright account is ready to claim",
                preheader:
                    "Someone set up a SetWright account for this address. One link claims it.",
                eyebrow: "INVITATION",
                heading: "Claim your SetWright account",
                body: [
                    `Someone set up a SetWright account for this email address. ${WHAT_SETWRIGHT_IS}`,
                    "What happens next depends on who invited you. If a director invited you to their group, opening the link binds your seat on their roster. If you are being set up to run your own group, opening the link creates it.",
                    "Either way, you choose a password on the next screen and land straight in.",
                ],
                button: "Claim your account",
                finePrint: IGNORE,
                // Not EXPIRES_RESEND: /auth/auth-error offers a fresh link through
                // refresh_pending_invite, which only touches member_invite rows. A director
                // on-ramp invitee has no such row, so this shared body cannot promise one.
                expiry: EXPIRES_NEUTRAL,
            };

        case "invite_member": {
            const panel: string[] = [];
            if (ensemble) panel.push(ensemble);
            if (inviter) panel.push(`Invited by ${inviter}`);
            let opener: string;
            if (ensemble && inviter) {
                opener = `${inviter} has given you a seat in ${ensemble} on SetWright.`;
            } else if (ensemble) {
                opener = `You have been given a seat in ${ensemble} on SetWright.`;
            } else {
                opener =
                    "A director has invited you to their group on SetWright.";
            }
            return {
                linkType: "invite",
                subject: ensemble
                    ? `Your seat with ${ensemble} is ready`
                    : "Claim your seat on SetWright",
                preheader:
                    "Claim your seat, set your availability, and see what is coming up.",
                eyebrow: "INVITATION",
                heading: ensemble
                    ? `Your seat with ${ensemble}`
                    : "Claim your seat",
                body: [
                    opener,
                    "SetWright is how the group works out what it can actually sing on the night. Claim your seat and you can mark the dates you are free, record the parts you cover, and see what is coming up.",
                    "You choose a password on the way in.",
                ],
                panel: panel.length ? panel : undefined,
                button: "Claim your seat",
                finePrint: IGNORE,
                // Reached only on invite_kind === 'member', which only sendMemberInvite writes,
                // so this one provably has a member_invite row and the offer is accurate.
                expiry: EXPIRES_RESEND,
            };
        }

        case "invite_director": {
            const group = ensemble || "your ensemble";
            return {
                linkType: "invite",
                subject: ensemble
                    ? `Set up ${ensemble} on SetWright`
                    : "Set up your ensemble on SetWright",
                preheader:
                    "Your director account is waiting. Claim it, pick a password, and your group is created.",
                eyebrow: "DIRECTOR SETUP",
                heading: ensemble
                    ? `Set up ${ensemble}`
                    : "Set up your ensemble",
                body: [
                    name
                        ? `Hi ${name}. A SetWright admin has set you up to run ${group}.`
                        : `A SetWright admin has set you up to run ${group}.`,
                    `Opening the link below creates ${group}, puts you in as its director, and drops you on its dashboard. You choose a password on the way.`,
                    "From there you add your singers, record who covers which part, and let SetWright draft a set the group can actually sing.",
                ],
                panel: ensemble ? [ensemble] : undefined,
                button: "Claim your account",
                finePrint: IGNORE,
                expiry: EXPIRES_NEUTRAL,
            };
        }

        // Sent when an invited address already holds a confirmed account, because GoTrue
        // refuses to invite one. To that reader an unexplained sign-in link looks like a
        // phishing attempt, so name the situation. It goes only to the address in question,
        // so telling this reader leaks nothing to anyone probing.
        case "magiclink":
            return {
                linkType: "magiclink",
                subject: "Your SetWright sign-in link",
                preheader:
                    "This address already has a SetWright account, so here is a sign-in link.",
                eyebrow: "SIGN IN",
                heading: "Your sign-in link",
                body: [
                    "A director invited this email address to their group on SetWright. The address already has a SetWright account, so instead of a new invitation, here is a sign-in link.",
                    "Opening it signs you in and binds any seat waiting for this address. Your existing password still works, and nothing else about your account changes.",
                ],
                button: "Sign in",
                finePrint:
                    "If you were not expecting this, you can ignore this email. Do not forward it: anyone who opens the link signs in as you.",
                expiry: EXPIRES_PLAIN,
            };

        // Doubles as the path for an invited member who never set a password.
        case "recovery":
            return {
                linkType: "recovery",
                subject: "Reset your SetWright password",
                preheader:
                    "Open the link to choose a new password. Your current one works until you do.",
                eyebrow: "PASSWORD",
                heading: "Reset your password",
                body: [
                    "Someone asked to reset the SetWright password for this address. Open the link below and you can choose a new one.",
                    "This is also the link to use if you were invited to a group and never got round to setting a password. Same screen, same result: pick one, and you can sign in with it from then on.",
                ],
                button: "Reset your password",
                finePrint:
                    "If you did not ask for this, you can ignore this email. Your current password keeps working unless someone opens this link and sets a new one. Do not forward it: opening the link signs you in.",
                expiry: EXPIRES_PLAIN,
            };

        // No ensemble is promised here. create_ensemble_seeded consumes a founding credit,
        // the column defaults to zero, and only a platform admin can grant one, so a
        // self-serve signup confirm does NOT create the group typed at sign-up.
        case "signup":
            return {
                linkType: "signup",
                subject: "Confirm your email and finish signing up",
                preheader:
                    "One link confirms this address and finishes your SetWright account.",
                eyebrow: "CONFIRM",
                heading: "Confirm your email address",
                body: [
                    "You signed up for SetWright. Confirm this address and your account is live.",
                    "You can set your group up once you are in.",
                ],
                button: "Confirm my email",
                finePrint:
                    "If you did not sign up for SetWright, you can ignore this email. The account stays unconfirmed and unusable until someone opens this link.",
                expiry: EXPIRES_PLAIN,
            };

        // One body that reads correctly from either inbox, because GoTrue renders this
        // template for both addresses and the Go surface does not branch.
        case "email_change_shared":
            return {
                linkType: "email_change",
                subject: "Confirm your SetWright email change",
                preheader:
                    "Both the old and the new address have to confirm before anything changes.",
                eyebrow: "EMAIL CHANGE",
                heading: "Confirm your email change",
                body: [
                    `A request was made to change the SetWright sign-in email on this account from ${current} to ${next}.`,
                    "Both addresses have to confirm. You are reading this at one of them, so open the link below to confirm your side. Nothing changes until both are done.",
                ],
                button: "Confirm the change",
                finePrint:
                    "If you did not ask for this, do not open the link. Ignore this email and the address on the account stays as it is. If you are concerned, set a new password from the sign-in screen.",
                expiry: EXPIRES_PLAIN,
            };

        // Goes to the address currently on the account. Half confirmation, half security notice.
        case "email_change_current":
            return {
                linkType: "email_change",
                subject: "Your SetWright sign-in email is being changed",
                preheader:
                    "Someone asked to move sign-in away from this address. Confirm it, or ignore it.",
                eyebrow: "SECURITY",
                heading: "Your sign-in email is being changed",
                body: [
                    `A request was made to change the SetWright sign-in email on this account from ${current} to ${next}.`,
                    "The change has to be confirmed from both addresses. This is the confirmation for the current one. Nothing moves until both are done.",
                ],
                button: "Confirm the change",
                finePrint:
                    "If you did not ask for this, do not open the link. Ignore this email and your sign-in address stays as it is. If you are concerned, set a new password from the sign-in screen.",
                expiry: EXPIRES_PLAIN,
            };

        // Goes to the address being moved to. A plain confirmation, and the only one of the
        // two whose second paragraph depends on whether the other half exists.
        case "email_change_new":
            return {
                linkType: "email_change",
                subject: "Confirm your new SetWright email address",
                preheader:
                    "You sign in with this address once the change is confirmed.",
                eyebrow: "EMAIL CHANGE",
                heading: "Confirm your new email address",
                body: [
                    "This address was given as the new sign-in email for a SetWright account. Confirm it to finish the change.",
                    v.dualConfirm
                        ? "The old address gets its own confirmation. The change takes effect only when both are confirmed, and from then on you sign in with this address."
                        : "The change takes effect once you confirm, and from then on you sign in with this address.",
                ],
                button: "Confirm this address",
                finePrint:
                    "If this is not your account, you can ignore this email. Nothing changes and this address is not added to any account.",
                expiry: EXPIRES_PLAIN,
            };
    }
}
