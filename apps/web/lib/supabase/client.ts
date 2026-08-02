// The browser Supabase client, for the few Client Components that talk to auth
// directly (the login form). It carries the public anon key only; all data access
// still goes through the server (the repository / source seams), RLS-scoped to the
// session this client establishes.
//
// It reads the NEXT_PUBLIC_* vars directly rather than via lib/env: those are inlined
// into the client bundle, whereas lib/env's `dataSource` is derived from DATA_SOURCE,
// which is NOT public and so reads as 'mock' on the client — which would blank the
// URL/key. This is only ever constructed in supabase mode (the login form renders
// nowhere else), where these vars are set.

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_COOKIE_OPTIONS } from "../cookies";

export function browserClient() {
    // This client writes the session cookie first, at sign-in, so it needs the same Secure
    // attribute as the server sites. NODE_ENV is inlined into the client bundle, so the
    // production check resolves here too.
    return createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { cookieOptions: SUPABASE_COOKIE_OPTIONS },
    );
}
