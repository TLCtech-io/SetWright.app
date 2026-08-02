// The typed, fail-fast environment contract (shared/public values).
//
// The public Supabase values (URL + anon key) are safe in the browser. The server-only
// service-role secret lives in env.server.ts and is never re-exported here. When
// DATA_SOURCE=supabase the Supabase vars are required, so a misconfiguration fails at
// startup with a clear message instead of surfacing as a cryptic error at the first query.

export type DataSource = "mock" | "supabase";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required env var ${name}. Set it in apps/web/.env.local (see .env.example).`,
        );
    }
    return value;
}

// Resolve the backing store, failing CLOSED in production: a missing or mock DATA_SOURCE in a
// production deployment would otherwise silently serve the unauthenticated in-memory mock. Require
// it at production RUNTIME, and refuse mock there unless explicitly opted in (ALLOW_PRODUCTION_MOCK,
// for an intentional preview). The guard is skipped during `next build` (NEXT_PHASE) so a mock-mode
// build still works — `next build` sets NODE_ENV=production, but no requests are served then; the
// check that matters is at `next start`. Dev and CI keep the convenient mock default.
const rawSource = process.env.DATA_SOURCE;
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
const isProductionRuntime =
    process.env.NODE_ENV === "production" && !isBuildPhase;
const allowProductionMock = process.env.ALLOW_PRODUCTION_MOCK === "true";

if (!rawSource && isProductionRuntime && !allowProductionMock) {
    throw new Error(
        "DATA_SOURCE is required in production. Set DATA_SOURCE=supabase.",
    );
}

const resolvedSource = rawSource ?? "mock";
if (resolvedSource !== "mock" && resolvedSource !== "supabase") {
    throw new Error(
        `DATA_SOURCE must be 'mock' or 'supabase', got '${resolvedSource}'.`,
    );
}
if (isProductionRuntime && resolvedSource === "mock" && !allowProductionMock) {
    throw new Error(
        "Mock data is disabled in production. Set DATA_SOURCE=supabase (or ALLOW_PRODUCTION_MOCK=true for an intentional preview/build job).",
    );
}

// The override is allowed (a throwaway preview/demo is a real use case), but it must never be
// silent: in mock mode there is NO auth, so the whole deployment is one shared, writable dataset.
// A loud startup line makes an accidental ALLOW_PRODUCTION_MOCK=true impossible to miss in logs.
if (isProductionRuntime && resolvedSource === "mock" && allowProductionMock) {
    console.warn(
        "[SECURITY] ALLOW_PRODUCTION_MOCK is set: this production deployment serves the UNAUTHENTICATED " +
            "in-memory mock — every visitor reads and writes one shared dataset. Use only for a throwaway " +
            "preview/demo, never with real data.",
    );
}

/** Which backing store the app reads. Defaults to the in-memory mock outside production. */
export const dataSource: DataSource = resolvedSource;

// Required only in supabase mode; empty strings in mock mode so importing this module never
// crashes a mock-only run (the common path for local dev and CI).
export const supabaseUrl =
    dataSource === "supabase" ? requireEnv("NEXT_PUBLIC_SUPABASE_URL") : "";
export const supabaseAnonKey =
    dataSource === "supabase"
        ? requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        : "";

// The `role` claim of a Supabase JWT key, or null for the new non-JWT key formats
// (sb_publishable_… / sb_secret_…) which can't be decoded. Shared with env.server.ts. Uses
// atob (not Buffer) so it is safe in the Edge runtime where the proxy loads this module.
export function supabaseKeyRole(key: string): string | null {
    const parts = key.split(".");
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(atob(padded)) as { role?: unknown };
        return typeof payload.role === "string" ? payload.role : null;
    } catch {
        return null;
    }
}

// Fail closed if a PRIVILEGED key was pasted into the PUBLIC anon var: Next ships
// NEXT_PUBLIC_* to every browser, so a service-role JWT (role=service_role) or an
// sb_secret_… key here would hand every visitor RLS-bypassing access. Covers both the legacy
// JWT and the new key formats; an anon/publishable key passes.
if (dataSource === "supabase") {
    if (
        supabaseAnonKey.startsWith("sb_secret_") ||
        supabaseKeyRole(supabaseAnonKey) === "service_role"
    ) {
        throw new Error(
            "NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a SERVICE-ROLE/secret key. The public key must be the anon " +
                "(publishable) key — a secret key here is shipped to the browser and bypasses Row-Level Security.",
        );
    }
}
