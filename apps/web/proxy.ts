// Session proxy (Next 16's renamed middleware). In supabase mode it refreshes the
// auth session on every request (the @supabase/ssr requirement), turns away
// unauthenticated requests (a /login redirect for pages, a 401 for /api), and keeps the
// active-ensemble cookie in lockstep with the /e/:ensembleId URL (validating membership)
// so the RLS-scoped server client always scopes to the ensemble the URL is showing. In
// mock mode there is no auth or tenancy, so this is a pass-through and the app behaves
// exactly as before.
//
// CSRF: the session + active_ensemble cookies are SameSite=Lax, so a cross-site POST/PUT/
// PATCH/DELETE never carries them — a forged request from another origin lands here with no
// `user` and is rejected (401 on /api). Lax sends cookies only on top-level GET navigations,
// which are non-mutating, so no separate CSRF token is needed for these first-party routes.
// As defense in depth, a mutating /api request whose browser-set Origin (or Referer)
// names a different host is refused outright (403) before any auth work — a browser cannot
// forge or strip the Origin on a cross-origin request, so this closes the vector even if a
// future cookie ever loosened to SameSite=None.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { dataSource, supabaseAnonKey, supabaseUrl } from "./lib/env";
import {
    ACTIVE_ENSEMBLE_COOKIE,
    ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
} from "./lib/ensemble";
import { crossOriginWriteRefused } from "./lib/csrf";
import { MAX_REQUEST_BYTES } from "./lib/limits";
import { isPublicId } from "./lib/publicId";
import { memberBounceTarget } from "./lib/ensemblePath";
import { isAdminPath } from "./lib/adminPath";

export async function proxy(request: NextRequest) {
    if (dataSource !== "supabase") return NextResponse.next();

    // Refuse a cross-origin mutating API call (defense in depth — see the header note),
    // before any auth work. The decision is a pure header check (lib/csrf, unit-tested).
    if (
        crossOriginWriteRefused({
            method: request.method,
            pathname: request.nextUrl.pathname,
            origin: request.headers.get("origin"),
            referer: request.headers.get("referer"),
            host: request.headers.get("host"),
            forwardedProto: request.headers.get("x-forwarded-proto"),
        })
    ) {
        return new NextResponse(
            JSON.stringify({ error: "cross-origin request refused" }),
            {
                status: 403,
                headers: { "content-type": "application/json" },
            },
        );
    }

    // Refuse an oversized request body up front (defense in depth): a multi-megabyte JSON body
    // would be fully parsed by the route. Content-Length covers the common case (a hostile client
    // that omits it still hits the per-array coercer caps downstream).
    if (
        request.nextUrl.pathname.startsWith("/api") &&
        request.method !== "GET" &&
        request.method !== "HEAD"
    ) {
        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
            return new NextResponse(
                JSON.stringify({ error: "request body too large" }),
                {
                    status: 413,
                    headers: { "content-type": "application/json" },
                },
            );
        }
    }

    let response = NextResponse.next({ request });
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                for (const { name, value } of cookiesToSet)
                    request.cookies.set(name, value);
                response = NextResponse.next({ request });
                for (const { name, value, options } of cookiesToSet)
                    response.cookies.set(name, value, options);
            },
        },
    });

    // getUser() refreshes the session if needed and writes the rotated cookies onto
    // `response` via setAll above. Do not run other logic between this and the redirects.
    const {
        data: { user },
    } = await supabase.auth.getUser();

    // A redirect must carry forward whatever session cookies @supabase/ssr just rotated onto
    // `response`; a bare NextResponse.redirect drops them, which on the unlucky
    // request where a refresh-token rotation coincides with a redirect can force a re-login.
    const redirectTo = (pathname: string, search?: string): NextResponse => {
        const url = request.nextUrl.clone();
        url.pathname = pathname;
        if (search !== undefined) url.search = search;
        const res = NextResponse.redirect(url);
        for (const cookie of response.cookies.getAll()) res.cookies.set(cookie);
        return res;
    };

    const path = request.nextUrl.pathname;
    // /api/auth/resend is the one intentionally-public API endpoint (self-serve invite resend); it is
    // rate-limited and enumeration-safe in its own handler. Matched exactly, not as an /api/auth/ prefix,
    // so no future /api/auth/* route is exposed by accident.
    const isPublic =
        path.startsWith("/login") ||
        path.startsWith("/signup") ||
        path.startsWith("/auth") ||
        path === "/api/auth/resend";
    if (!user && !isPublic) {
        // API clients get a 401 they can act on, not an HTML login page they'd have to parse.
        if (path.startsWith("/api")) {
            return new NextResponse(
                JSON.stringify({ error: "not authenticated" }),
                {
                    status: 401,
                    headers: { "content-type": "application/json" },
                },
            );
        }
        // Carry the original path (and query) as ?next so login can return the user to the deep link
        // they were headed to, not just the dashboard. Skip it for the bare home ('/'): login already
        // resolves there, so next=/ is redundant noise (and it changed the plain /login redirect the
        // sign-out flow and e2e expect). Login validates next is app-relative before honoring it, so it
        // can never be an open redirect.
        const nextParam =
            path === "/"
                ? ""
                : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
        return redirectTo("/login", nextParam);
    }

    // Platform-admin perimeter. The admin console (/admin pages) and its endpoints (/api/admin) are
    // reachable only by a platform admin; a signed-in non-admin is turned away before the route runs —
    // a 403 JSON on the API (an admin client can act on it), a redirect home on a page (reveal nothing).
    // The flag lives in app_user and is read through the auth_is_platform_admin() DEFINER function (a
    // normal client cannot read the column directly). Fail closed: any non-true result — a normal user
    // OR an RPC error — is denied. Sits before the /e/:token block; admin routes are not tenant-scoped.
    if (user && isAdminPath(path)) {
        const { data: isAdmin } = await supabase.rpc("auth_is_platform_admin");
        if (isAdmin !== true) {
            if (path.startsWith("/api")) {
                return new NextResponse(
                    JSON.stringify({ error: "forbidden" }),
                    {
                        status: 403,
                        headers: { "content-type": "application/json" },
                    },
                );
            }
            return redirectTo("/");
        }
    }

    // On a /e/:ensemble page the segment is a public_id token. Resolve it to the internal uuid and
    // make that ensemble the active one — but only if the user actually belongs to it (a forged or
    // stale token otherwise leaks nothing: bounce home). Setting the cookie on the request lets this
    // same render scope correctly; setting it on the response persists it for the page's later
    // /api/* calls and future navigations. The cookie stays uuid-based; only the URL is a token.
    const match = /^\/e\/([^/]+)/.exec(path);
    if (user && match) {
        const token = match[1]!;
        // A malformed token names nothing, so short-circuit to home rather than round-trip.
        if (!isPublicId(token)) {
            return redirectTo("/");
        }
        // Resolve the token to the uuid in the membership query. !inner makes the public_id filter
        // restrict the member rows to the matching ensemble (a left embed would keep every membership
        // and null the non-matching embed). The member row is self-readable even in an archived
        // ensemble, but the embedded ensemble is only visible when ensemble_read passes (an ACTIVE
        // tenant), so a null embed means archived/suspended. Bounce home rather than render an empty,
        // content-less tenant page.
        const { data: membership } = await supabase
            .from("member")
            .select(
                "permission_tier, ensemble:ensemble_id!inner(id, public_id)",
            )
            .eq("user_id", user.id)
            .eq("ensemble.public_id", token)
            .eq("status", "active")
            .maybeSingle();
        // PostgREST returns a to-one embed as an object, but the untyped client can widen it to an
        // array; normalize before reading the resolved uuid.
        const ensemble = (
            Array.isArray(membership?.ensemble)
                ? membership?.ensemble[0]
                : membership?.ensemble
        ) as { id: string } | null | undefined;
        if (!membership || !ensemble) {
            return redirectTo("/");
        }
        const ensembleId = ensemble.id; // the resolved uuid, what the active_ensemble cookie holds
        // Role gate: a non-director only ever sees their own self-service surface under /e/:token/me.
        // memberBounceTarget returns where they belong, or null when the page is member-allowed (its
        // own surface, or the shared role-branched event-detail route). Only PAGE paths reach here
        // (API is /api/*, which RLS guards), so a member's own data writes are never blocked. The
        // target is built from the token, matching the URL the browser navigates.
        if (membership.permission_tier !== "director") {
            const bounce = memberBounceTarget(path, token);
            if (bounce) return redirectTo(bounce);
        }
        if (request.cookies.get(ACTIVE_ENSEMBLE_COOKIE)?.value !== ensembleId) {
            request.cookies.set(ACTIVE_ENSEMBLE_COOKIE, ensembleId);
            const synced = NextResponse.next({ request });
            // Carry over any session cookies @supabase/ssr rotated onto the old response.
            for (const cookie of response.cookies.getAll())
                synced.cookies.set(cookie);
            synced.cookies.set(
                ACTIVE_ENSEMBLE_COOKIE,
                ensembleId,
                ACTIVE_ENSEMBLE_COOKIE_OPTIONS,
            );
            response = synced;
        }
    }

    return response;
}

export const config = {
    // Run on everything except static assets; the body decides per data source.
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    ],
};
