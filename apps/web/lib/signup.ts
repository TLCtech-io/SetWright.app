// Whether brand-new accounts can self-register. CLOSED by default: SetWright is invite-only for now (an
// anti-spam gate while pre-launch), and directors are onboarded by a platform admin. Set PUBLIC_SIGNUP
// to 'true' to reopen public registration (the free-tier launch) — SignupForm stays wired for that day,
// so reopening is a config flip, not a code change. Server-only read (the signup + login pages are
// server components).
export const publicSignupOpen = process.env.PUBLIC_SIGNUP === "true";
