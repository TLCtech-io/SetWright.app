// Cookie attributes shared by every cookie this app sets.
//
// One place, so the auth session cookie and the active-ensemble selection cannot drift apart
// on the attribute that matters most.

// Secure everywhere except `next dev`, which is the one context that genuinely needs plain
// http to work.
//
// Read the polarity carefully, because it is the point. Testing for "development" rather than
// for "production" makes the safe answer the default: an unset, misspelled, or overridden
// NODE_ENV yields Secure, not a session token in the clear. `next start` only DEFAULTS
// NODE_ENV to production (next/dist/bin/next: `process.env.NODE_ENV || defaultEnv`), so a
// pre-set value is honoured with nothing but a warning, and a self-hosted deploy that gets it
// wrong would otherwise ship every session cookie unprotected. There is no assertion available
// that could catch that, since the app cannot tell a real deployment from a local run, so the
// default has to be the secure one.
//
// The Playwright run is not an exception: playwright.config.ts starts a production build
// (`next build && next start`), so Secure is on there and the cookie is set over plain http on
// 127.0.0.1. Chromium treats loopback as a potentially trustworthy origin and stores it anyway,
// which is what the active_ensemble cookie has always relied on. Note that Playwright's own
// APIRequestContext does NOT (see test/e2e/admin-gate.spec.ts).
export const SECURE_COOKIES = process.env.NODE_ENV !== "development";

// Handed to @supabase/ssr at every client construction site. Without it the session cookie
// ships with no Secure attribute: the library's DEFAULT_COOKIE_OPTIONS sets path, sameSite,
// httpOnly and maxAge but never `secure`, and it never derives one from the request. That
// cookie carries the access and refresh tokens, so it is the last one that should ever go
// out in the clear.
//
// The library merges this object over its defaults rather than replacing them, so naming
// only `secure` leaves path, sameSite and maxAge intact. Omitting `name` leaves the cookie
// name alone; supabase-js falls back to its own storageKey.
//
// httpOnly stays false by @supabase/ssr design, because the browser client has to read the
// token. That is not ours to change here.
//
// maxAge is deliberately absent. The library discards a caller-supplied maxAge and forces
// its own 400-day value on the set path, so passing one would be a no-op that reads as
// working. Shortening the session lifetime is a Supabase project setting, not something
// this object can carry.
export const SUPABASE_COOKIE_OPTIONS = {
    secure: SECURE_COOKIES,
};
