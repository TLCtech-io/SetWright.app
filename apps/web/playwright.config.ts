// Playwright E2E config. Builds and starts a supabase-mode production server (the env is pulled from the
// running local stack via `supabase status`) and runs the browser tests against it.
// Needs the stack up + Docker, like the integration suite. `npm run test:e2e`.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const status = execSync("npx supabase status -o env", {
    cwd: repoRoot,
    encoding: "utf8",
});
const supabaseUrl = /API_URL="?([^"\n]+)/.exec(status)?.[1] ?? "";
const anonKey = /ANON_KEY="?([^"\n]+)/.exec(status)?.[1] ?? "";
// The service-role key too, so routes that need elevation (the admin director-invite: inviteUserByEmail)
// work against the local stack. Same source as the anon key; the local stack's key is ephemeral.
const serviceKey = /SERVICE_ROLE_KEY="?([^"\n]+)/.exec(status)?.[1] ?? "";

export default defineConfig({
    testDir: "./test/e2e",
    timeout: 30_000,
    fullyParallel: false,
    // One worker, always. Specs reuse a few seed users, so several share ana@example.com, and
    // auth.spec signs her out mid-run. Under parallel workers those concurrent same-user sessions
    // collide with refresh-token rotation, so one worker's server render transiently throws
    // "not authenticated" and shows the error boundary. CI passes only because Playwright defaults
    // to 1 worker when CI is set; pin it so a local run matches CI instead of flaking. Parallel e2e
    // would need a distinct seed user per worker.
    workers: 1,
    use: { baseURL: "http://127.0.0.1:3210" },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        // A production build, not `next dev`: it hydrates fast and deterministically, so
        // the client login handler is attached before the test interacts (dev's slow
        // hydration races the click into a native form submit). The NEXT_PUBLIC vars are
        // inlined at build time, so they must be present for the build, not just at start.
        command: 'sh -c "next build --webpack && next start -p 3210"',
        url: "http://127.0.0.1:3210/login",
        reuseExistingServer: false,
        timeout: 240_000,
        env: {
            ...process.env,
            DATA_SOURCE: "supabase",
            NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
            NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
            SUPABASE_SERVICE_ROLE_KEY: serviceKey,
            // Pin signup CLOSED so the invite-only specs are deterministic regardless of an ambient
            // PUBLIC_SIGNUP in the shell (the ...process.env spread above would otherwise leak it in).
            PUBLIC_SIGNUP: "",
        } as Record<string, string>,
    },
});
