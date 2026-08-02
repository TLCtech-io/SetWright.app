// Server-only secrets. NEVER import this from a Client Component.
//
// Next only ships NEXT_PUBLIC_* env vars to the browser, so a non-prefixed secret like the
// service-role key is server-only by construction (it is simply undefined on the client).
// The runtime guard below is belt-and-suspenders against an accidental client import. The
// lookup is lazy (it throws only when the key is actually needed), so importing this module
// never crashes a mock-only run that has no service-role key configured.

import { supabaseKeyRole } from "./env";

if (typeof window !== "undefined") {
    throw new Error(
        "env.server.ts must not be imported in client code — it reads a server-only secret.",
    );
}

/**
 * The Supabase service-role key, for privileged/admin operations that bypass RLS (e.g. the
 * member-invite edge flow). Read it ONLY in server code (route handlers, server actions),
 * never in a request that could echo it, and never build the per-user client from it.
 */
export function serviceRoleKey(): string {
    const value = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!value) {
        throw new Error(
            "Missing SUPABASE_SERVICE_ROLE_KEY (server-only). Set it in apps/web/.env.local (see .env.example).",
        );
    }
    // Catch the inverse mistake of the anon-key guard in env.ts: a public anon/publishable key
    // pasted into the service-role slot would silently fail every admin operation.
    if (
        value.startsWith("sb_publishable_") ||
        supabaseKeyRole(value) === "anon"
    ) {
        throw new Error(
            "SUPABASE_SERVICE_ROLE_KEY looks like the ANON/publishable key, not the service-role secret. " +
                "Use the service-role key for privileged operations.",
        );
    }
    return value;
}
