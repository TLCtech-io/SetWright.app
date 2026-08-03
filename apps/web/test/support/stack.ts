// Local Supabase stack access, shared by the integration suite and the e2e global setup.
//
// Both tiers need the same two things: the running stack's connection details, and a way to put
// the data back to the seeded state. Keeping one copy means the reset cannot drift between them.
// This module deliberately imports nothing from the app, so the e2e setup can use it without
// dragging the repository layer into a Playwright process.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// apps/web/test/support -> repo root
const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
);

let cachedEnv: {
    url: string;
    anon: string;
    service: string;
    dbUrl: string;
} | null = null;

export function supaEnv(): {
    url: string;
    anon: string;
    service: string;
    dbUrl: string;
} {
    if (cachedEnv) return cachedEnv;
    const out = execSync("npx supabase status -o env", {
        cwd: repoRoot,
        encoding: "utf8",
    });
    const url = /API_URL="?([^"\n]+)/.exec(out)?.[1];
    const anon = /ANON_KEY="?([^"\n]+)/.exec(out)?.[1];
    const service = /SERVICE_ROLE_KEY="?([^"\n]+)/.exec(out)?.[1];
    const dbUrl = /DB_URL="?([^"\n]+)/.exec(out)?.[1];
    if (!url || !anon || !service || !dbUrl)
        throw new Error(
            "`supabase status` returned no API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL, is the local stack up?",
        );
    cachedEnv = { url, anon, service, dbUrl };
    return cachedEnv;
}

/**
 * Clean slate, WITHOUT `supabase db reset`. A full reset drops/recreates the database, which severs
 * GoTrue's connection and 502s the gateway for minutes on a loaded CI runner (the old flaky
 * failures). Instead we reset the DATA over the live connection: truncate every table + reload the
 * seed (see supabase/test-reset.sql), so GoTrue is never disturbed. Schema is unchanged, so
 * re-applying migrations (what `db reset` also does) isn't needed here; `supabase start` applies
 * them once at the top of the job.
 */
export function resetDb(): void {
    const { dbUrl } = supaEnv();
    // Concatenate test-reset.sql (set jwt_secret + truncate) and seed.sql and pipe the whole thing
    // to psql over stdin, one session (so the guard passes), no \i/\ir include or cwd-relative path
    // to get wrong. Capture stderr so any SQL error surfaces in the log instead of a bare
    // "Command failed".
    const sql = `${readFileSync(join(repoRoot, "supabase", "test-reset.sql"), "utf8")}
${readFileSync(join(repoRoot, "supabase", "seed.sql"), "utf8")}`;
    try {
        execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -q`, {
            input: sql,
            stdio: ["pipe", "ignore", "pipe"],
            encoding: "utf8",
        });
    } catch (e) {
        const err = e as { stderr?: string };
        throw new Error(
            `data reset (psql) failed: ${(err.stderr || "").trim() || (e as Error).message}`,
        );
    }
}
