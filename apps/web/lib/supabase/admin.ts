// The service-role Supabase admin client. SERVER-ONLY.
//
// It is built from the service-role secret (lib/env.server.ts), which BYPASSES Row-Level
// Security, so it must never be constructed in, or reachable from, client code. Use it
// ONLY for privileged auth-admin operations that genuinely need elevation: inviting a
// member by email, generating a sign-in link. NEVER query a tenant table with it. Reading
// or writing per-user data always goes through the signed-in user's RLS-scoped client
// (lib/supabase/server.ts, then the repository). This client carries no user session
// (persistSession: false); it authenticates with the secret on each call.
//
// One carve-out, and it is worth stating precisely. The unauthenticated resend route calls
// two SECURITY DEFINER RPCs granted to service_role. refresh_pending_invite updates
// member_invite, which is a tenant table. consume_invite_quota_by_email writes
// invite_rate_event, which carries no ensemble_id and is deny-all under RLS, so it is not
// tenant data but it is still an elevated per-user write.
//
// Note where the elevation comes from. SECURITY DEFINER is what bypasses RLS; this key only
// decides who may call. Both RPCs take the target email as a scalar argument straight from
// an unauthenticated request body, so a caller does choose which row the elevated statement
// touches. What a caller cannot do is widen the predicate: its shape is fixed in SQL, neither
// RPC accepts a filter expression, and neither returns another tenant's data. That bounds the
// blast radius to a single email address. Add another only on those terms.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "../env";
import { serviceRoleKey } from "../env.server";

export function adminClient(): SupabaseClient {
    return createClient(supabaseUrl, serviceRoleKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}
