// Pure same-origin decision for the proxy's CSRF gate. Header-only and dependency-free,
// so it is testable in isolation from the Next/Supabase middleware around it.
//
// A mutating state-changing request is refused when a browser-set Origin (or, failing that,
// Referer) names a host other than the request's own. The expected host comes from the Host header
// (the browser's view of the host[:port]) — NOT nextUrl.origin, which behind a TLS-terminating
// proxy can differ from what the browser sent and falsely reject a same-origin request (it broke
// sign-out in the production E2E server). Scheme is checked only when the proxy declares it via
// x-forwarded-proto, so a same-host cross-scheme attacker is still caught in production without
// false-rejecting where the internal scheme is unknown. An absent Origin/Referer is same-origin or
// a non-browser client (a browser cannot omit the Origin on a cross-origin request), so it is
// allowed; SameSite=Lax cookies remain the primary defense. A present-but-unparseable value is
// refused, since a well-formed browser request never produces one.

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// The state-changing surfaces a forged cross-origin POST could hit. /api is the bulk of it;
// /auth/signout is a mutating POST that lives outside /api (a logout-CSRF would force a sign-out).
//
// /auth/confirm is the deliberate exception, and it is worth being exact about why, because it
// reads at a glance like a harmless email landing. It is not: it claims invited seats, can create
// and seed an ensemble, and rewrites user metadata. It is also a GET, so SAFE_METHODS exempts it
// before this list is consulted, and adding it here would change nothing. What protects it is the
// single-use token it verifies first: every one of those writes sits behind a successful
// verifyOtp, which a cross-origin caller cannot forge. The GET exemption has to stay, or the link
// in the email stops working.
function isProtectedPath(pathname: string): boolean {
    return (
        pathname.startsWith("/api") ||
        pathname === "/auth/signout" ||
        pathname.startsWith("/auth/signout/")
    );
}

export function crossOriginWriteRefused(req: {
    method: string;
    pathname: string;
    origin: string | null;
    referer: string | null;
    host: string | null; // the Host header — the browser's view of the host[:port]
    forwardedProto: string | null; // x-forwarded-proto when behind a TLS-terminating proxy, else null
}): boolean {
    if (!isProtectedPath(req.pathname)) return false;
    if (SAFE_METHODS.has(req.method)) return false;
    const stated = req.origin ?? req.referer;
    if (!stated) return false; // no browser-stated origin: same-origin or non-browser — allow
    let url: URL;
    try {
        url = new URL(stated);
    } catch {
        return true; // present but unparseable: refuse
    }
    if (req.host === null || url.host !== req.host) return true; // host mismatch (browser view both sides)
    if (req.forwardedProto && url.protocol !== `${req.forwardedProto}:`)
        return true; // scheme mismatch when known
    return false;
}
