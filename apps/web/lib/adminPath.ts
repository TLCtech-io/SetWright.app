// Which request paths the platform-admin perimeter gate protects. The admin console lives at /admin
// (pages) and its write endpoints under /api/admin (API). Exact-or-subpath matching, so a lookalike
// segment like /administrator or /api/administer is never caught. Pure and path-only so the proxy
// stays thin and this is unit-tested; the proxy does the auth_is_platform_admin RPC and the response
// (a 403 for API, a redirect home for pages).
export function isAdminPath(pathname: string): boolean {
    return (
        pathname === "/admin" ||
        pathname.startsWith("/admin/") ||
        pathname === "/api/admin" ||
        pathname.startsWith("/api/admin/")
    );
}
