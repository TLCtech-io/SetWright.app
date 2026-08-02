// Whether /auth/confirm should seed the ensemble the user typed, given the verified link's type and the
// pending_ensemble_name carried in their metadata. True when a pending name is present AND the link type
// is one that legitimately carries one: a director invite (type=invite, stamped by sendDirectorInvite) or
// a self-signup confirmation (signup/email/magiclink). Recovery and email-change confirmations never seed,
// and an unknown type fails closed.
//
// This type gate is defense-in-depth only. The real authorization is the founding-credit gate inside
// create_ensemble_seeded (migration 057), which a user cannot self-grant, so even a user who sets their
// own pending_ensemble_name and reaches here cannot create a free ensemble. The route applies a second,
// independent guard — that the user does not already direct an active ensemble — before creating, so this
// is a necessary, not a sufficient, condition. Extracted for a unit test, like confirmDestination.
const SEEDABLE_TYPES = new Set(["invite", "signup", "email", "magiclink"]);

export function pendingSeedApplies(
    type: string,
    pendingName: string | undefined | null,
): boolean {
    return !!pendingName && SEEDABLE_TYPES.has(type);
}
