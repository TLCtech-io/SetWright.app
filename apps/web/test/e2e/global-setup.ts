// Put the database back to its seeded state once, before the e2e suite runs.
//
// Without this the suite is only repeatable against a freshly started stack. email-change.spec.ts
// changes rae@example.com to rae.new@example.com for good, so a second run against the same
// database cannot sign her in and dies at the login screen. CI never saw it, because the job wraps
// every run in `supabase start` / `supabase stop`. A developer holding a stack up across runs sees
// it on the second run and every run after, and the failure points at the wrong thing.
//
// One reset for the whole suite rather than one per spec. The specs deliberately share a few seed
// users and run on a single worker, so a per-spec reset would pull the ground out from under
// whatever ran before it.

import { resetDb } from "../support/stack";

export default function globalSetup(): void {
    resetDb();
}
