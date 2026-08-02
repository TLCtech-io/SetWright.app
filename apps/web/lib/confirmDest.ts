// Where /auth/confirm sends the user after verifying their email OTP, by link type. Split out of the
// route so the branching is unit-testable without a live GoTrue/verifyOtp round trip.
//
// invite / recovery established a session with no usable password, so they go to /auth/welcome to set
// one (recovery also carries reset=1 so the screen frames itself as a reset; the ?e token is the
// ensemble to land in, omitted when there is none). magic-link / signup already chose a password, so
// they go straight to the ensemble dashboard, or to /auth/no-access when they belong to no ensemble (a
// verified link that bound no seat) so they can explain / request a fresh invite rather than a bare home.
//
// email / email_change is a self-service email change confirmed from the profile, so it lands the member
// back on that profile (where they started, and where the current address shows) with an ?email=changed
// flag the page reads to acknowledge it. GoTrue names the confirm type email_change; email is accepted too
// so a link built with the generic type still routes here rather than falling through to the dashboard.
export function confirmDestination(
    type: string,
    firstToken: string | null,
): string {
    const needsPassword = type === "invite" || type === "recovery";
    if (needsPassword) {
        const params = new URLSearchParams();
        if (firstToken) params.set("e", firstToken);
        if (type === "recovery") params.set("reset", "1");
        const qs = params.toString();
        return `/auth/welcome${qs ? `?${qs}` : ""}`;
    }
    if (type === "email" || type === "email_change") {
        return firstToken
            ? `/e/${firstToken}/me/profile?email=changed`
            : "/?email=changed";
    }
    return firstToken ? `/e/${firstToken}/dashboard` : "/auth/no-access";
}
