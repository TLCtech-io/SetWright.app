// Where /auth/welcome sends the user after they set (or skip) their password. Into their ensemble when
// there is one. Otherwise it depends on how they got here: a recovery (password-reset) session belongs to
// an EXISTING account that already has a home, so it falls back to the home resolver ('/'); a fresh invite
// that bound no seat has nowhere to go, so it lands on /auth/no-access to explain and offer a resend.
// Extracted for a unit test: sending a returning user who just reset their password to a "you have no
// access" page is a real regression, so this branch is pinned.
export function welcomeDest(
    ensembleToken: string | null,
    isReset: boolean,
    hasPendingInvitations = false,
): string {
    if (ensembleToken) return `/e/${ensembleToken}/dashboard`;
    // A reset comes before the invitation check on purpose: someone resetting a password asked to do
    // one thing, and interrupting them with a join decision they did not ask for is the behaviour this
    // flow deliberately avoids. Their invitation keeps until they go looking for it.
    if (isReset) return "/";
    return hasPendingInvitations ? "/auth/invitations" : "/auth/no-access";
}
