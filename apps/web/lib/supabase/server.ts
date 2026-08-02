// The per-request, RLS-scoped Supabase client. Built from the signed-in user's
// session cookies + the public anon key, so every query and RPC runs as that user
// and the row-level security at the SQL boundary draws the tenant line. NEVER build
// this from the service-role key for per-user data — that bypasses RLS.
//
// Server-only (it reads request cookies). Call it lazily inside a route handler or
// server component, where the request context exists. getRepository()/getSource()
// stay synchronous; they await this on each method call so going live never changed
// a call site.

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseUrl, supabaseAnonKey } from "../env";

export async function serverClient(): Promise<SupabaseClient> {
    const cookieStore = await cookies();
    return createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                // Writing refreshed-session cookies works from a route handler / server action.
                // From a server component the cookie store is read-only and throws; that is fine
                // here — the middleware (auth wiring) is what refreshes the session on navigation.
                try {
                    for (const { name, value, options } of cookiesToSet) {
                        cookieStore.set(name, value, options);
                    }
                } catch {
                    /* read-only cookie store (server component render) — ignore */
                }
            },
        },
    });
}
