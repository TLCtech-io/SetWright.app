// Shared setup for the Supabase adapter integration tests. These run the real
// createSupabaseRepository against the running local stack, signed in as a seeded
// user, so they exercise the SQL + RLS the unit-level types can't. They need the
// stack up (`npx supabase start`) and Docker; the runner resets the DB per domain.

import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseRepository } from "../../lib/supabase/repository";
import type { Repository } from "../../lib/repository";
import { resetDb, supaEnv } from "../support/stack";

// Stack access and the data reset live in test/support/stack.ts so the e2e global setup can share
// them without importing the repository layer. Re-exported here because every integration domain
// already reaches for them through this module.
export { resetDb, supaEnv };

/**
 * Confirm a freshly signed-up account's email via the admin API. Email confirmation is ON (so the
 * local stack matches the deployment target), so a brand-new signUp returns no session until the
 * email is confirmed — this stands in for the user clicking the confirmation link.
 */
export async function confirmUser(email: string): Promise<void> {
    const { url, service } = supaEnv();
    const admin = createClient(url, service, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await admin.auth.admin.listUsers();
    const user = data.users.find((u) => u.email === email);
    if (user && !user.email_confirmed_at) {
        await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
    }
}

/**
 * After a `db reset`, GoTrue reconnects to the freshly-reset database, and the Kong gateway
 * returns 502s until it does. `/auth/v1/health` answers *before* the token endpoint can
 * actually authenticate, so it is NOT a reliable readiness signal (this is what caused the
 * flaky "AuthRetryableFetchError status=502" failures that wandered between domains). Instead,
 * probe a real sign-in against a seeded account and only return once it succeeds — so a domain
 * never starts racing a not-yet-ready GoTrue. Generous timeout: on a loaded CI runner the
 * reconnect after a reset can take well over a minute.
 */
export async function waitForAuth(): Promise<void> {
    const { url, anon } = supaEnv();
    const probe = createClient(url, anon, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const deadline = Date.now() + 180_000;
    let last = "not attempted";
    while (Date.now() < deadline) {
        const { error } = await probe.auth.signInWithPassword({
            email: "ana@example.com",
            password: "password123",
        });
        if (!error) return; // gateway + GoTrue are up AND can authenticate against the reset DB
        const e = error as { name?: string; status?: number };
        last = `${e.name ?? "error"} status=${e.status ?? "?"}`;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`GoTrue not ready to authenticate after 180s: ${last}`);
}

/**
 * Sign in as a seeded account (password is the same for all) and build the adapter.
 * Retries with backoff: each domain runs after a `supabase db reset`, which restarts
 * containers, so the first sign-ins can race GoTrue coming back up on a loaded CI runner.
 * The client is created with auto-refresh OFF so a signed-in test client doesn't leave a
 * background token-refresh timer hammering GoTrue across the 11 sequential domains.
 */
export async function signInAs(
    email: string,
): Promise<{ repo: Repository; client: SupabaseClient }> {
    const { url, anon } = supaEnv();
    const client = createClient(url, anon, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    let last = "no attempt";
    for (let attempt = 0; attempt < 15; attempt += 1) {
        const { error } = await client.auth.signInWithPassword({
            email,
            password: "password123",
        });
        if (!error) return { repo: createSupabaseRepository(client), client };
        // AuthError props are non-enumerable, so JSON.stringify gives {}; capture them explicitly
        // so a persistent failure is diagnosable (429 rate-limit vs 5xx readiness vs bad creds).
        const e = error as {
            name?: string;
            status?: number;
            code?: string;
            message?: string;
        };
        last = `${e.name ?? "AuthError"} status=${e.status ?? "?"} code=${e.code ?? "?"} msg=${e.message || "(empty)"}`;
        // Longer, growing backoff — a just-restarted container can need well over 8s.
        await new Promise((r) => setTimeout(r, 1000 + attempt * 300));
    }
    throw new Error(`sign-in ${email} failed after retries: ${last}`);
}

/** A fresh anonymous client, for exercising sign-up of a brand-new account. */
export function freshClient(): SupabaseClient {
    const { url, anon } = supaEnv();
    return createClient(url, anon);
}

/** A service-role client (bypasses RLS). For the service-role-only RPCs, to test the privileged path
 *  a normal user is denied. Note: service_role is NOT a table superuser here (the schema grants tables
 *  to `authenticated`, not service_role), so use sqlAsPostgres for direct privileged table writes. */
export function serviceClient(): SupabaseClient {
    const { url, service } = supaEnv();
    return createClient(url, service, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

/** Run SQL as the postgres superuser over the local DB connection. This is the real admin-bootstrap
 *  path (an operator's statement in the Supabase SQL editor), distinct from service_role, which has no
 *  grant on app_user. */
export function sqlAsPostgres(sql: string): void {
    const { dbUrl } = supaEnv();
    execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -q`, {
        input: sql,
        stdio: ["pipe", "ignore", "pipe"],
        encoding: "utf8",
    });
}

/**
 * Run one SQL statement against the local database as postgres (over the same DB_URL resetDb uses)
 * and return its output, trimmed. For the few assertions that must observe a DB-level effect the
 * PostgREST surface can't drive — e.g. a trigger that fires on a raw auth.users write GoTrue owns.
 * -At gives tuples-only, unaligned output, so a single-column SELECT returns just the value.
 */
export function sql(statement: string): string {
    const { dbUrl } = supaEnv();
    return execSync(`psql "${dbUrl}" -At -v ON_ERROR_STOP=1`, {
        input: statement,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
    }).trim();
}

export function assert(cond: unknown, msg: string): void {
    if (!cond) throw new Error("assertion failed: " + msg);
    console.log("    ok -", msg);
}
