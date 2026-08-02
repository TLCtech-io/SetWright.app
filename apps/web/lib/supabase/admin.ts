// The service-role Supabase admin client. SERVER-ONLY.
//
// It is built from the service-role secret (lib/env.server.ts), which BYPASSES Row-Level
// Security, so it must never be constructed in — or reachable from — client code. Use it
// ONLY for privileged auth-admin operations that genuinely need elevation: inviting a
// member by email, generating a sign-in link. NEVER read or write per-user data with it —
// that always goes through the signed-in user's RLS-scoped client (lib/supabase/server.ts
// → the repository). This client carries no user session (persistSession: false); it
// authenticates with the secret on each call.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "../env";
import { serviceRoleKey } from "../env.server";

export function adminClient(): SupabaseClient {
    return createClient(supabaseUrl, serviceRoleKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
