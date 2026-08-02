// Only a same-origin, app-relative path is a safe redirect target (e.g. the login ?next return path).
// Prefix checks alone are NOT enough: WHATWG URL parsing strips ASCII tab/newline/CR, so "/\t/evil.com"
// would slip past a !startsWith('//') test and then resolve to the protocol-relative "//evil.com" (an
// off-site open redirect). Canonicalize against a fixed base and honor the value only if it stays on
// that origin, returning the resolved path+query+hash — which defeats protocol-relative, backslash,
// and control-character tricks alike.
export function safeNext(raw: string | undefined): string {
    if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
    try {
        const base = "https://internal.invalid";
        const u = new URL(raw, base);
        if (u.origin !== base) return "/";
        return u.pathname + u.search + u.hash;
    } catch {
        return "/";
    }
}
