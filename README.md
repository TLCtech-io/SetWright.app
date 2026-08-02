# SetWright

**Setlists your group can actually sing on the night.**

SetWright is a living repertoire system that drafts vocal set lists for a cappella groups, vocal bands, and choirs. The director keeps the artistic call. The tool does the bookkeeping a director botches by hand: who is available, who covers each part, what is performance-ready, and what fits the night. It is a commercial, multi-tenant product: one account can lead or sing in several groups, and each group's data stays its own.

A set list is a claim that a specific group of people can perform a specific run of songs, well, in a fixed amount of time, on a particular date. SetWright checks that claim before the director bets a rehearsal (or a gig) on it: real part coverage as a matching problem, not a headcount; readiness and content gates; a time budget that leans slightly short rather than running long; and a sequenced starting arc the director finishes by hand. When the pool falls short, it names the lever (which person's "yes" would unlock which song) instead of a dead end.

## Repository layout

A TypeScript monorepo, one language top to bottom, the same types from the database to the API to the client.

```
packages/
  core/   domain types and the set drafter. Pure logic, no storage, no transport
  db/     a parse harness that validates the SQL in supabase/. Holds no SQL itself
  api/    a thin library over the drafter. Not an HTTP server
apps/
  web/    the Next.js app. Director, member, and platform-admin consoles
supabase/
  migrations/   the schema, RLS policies, and hydration/write RPCs (58 migrations)
  functions/    the send-email edge function (Deno), for the invite/reset flow
```

`core` depends on nothing infrastructural, so it runs and tests in isolation. It is the fast feedback loop `db`, `api`, and `web` build on. A `mobile` client comes later.

## The cardinal rule

The schema is the contract. It is the whole ordered migration set in `supabase/migrations/`, not any one file, and applied migrations are immutable: never edit one, add a new migration. The domain types in `packages/core` match the schema directly, with no translation layer between database rows and the domain types. SQL reduces; TypeScript decides. The only filters the database applies are `status = 'active'` and, on the member pool, `is_singing`. Every gate the drafter runs (feasibility, readiness, context) runs in application code, in `packages/core`.

## Quick start

No database needed to look around. `DATA_SOURCE=mock` runs the whole app against an in-memory demo ensemble.

```bash
git clone <this-repo>
cd SetWright.app
npm install
npm run dev            # DATA_SOURCE=mock npm run dev --workspace apps/web
```

Then open `http://localhost:3000`. To run against a real Supabase project instead, set `DATA_SOURCE=supabase` plus `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` in `apps/web/.env.local`.

## Scripts

Run from the repository root (npm workspaces):

| Script                     | What it does                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run dev`              | Starts the web app in mock-data mode.                                                                  |
| `npm run typecheck`        | Type-checks every workspace: `core`, `api`, `db`, and `apps/web`.                                      |
| `npm run build`            | Production build of `apps/web`.                                                                        |
| `npm test`                 | Unit tests across every workspace that has them (`core`, `api`, `db`, plus `web`'s pure-helper tests). |
| `npm run test:integration` | Integration tests against a local Supabase stack (needs `supabase start` running first).               |
| `npm run test:e2e`         | Playwright end-to-end tests (belongs in CI against a live stack).                                      |
| `npm run verify`           | The offline gate: typecheck + build + all unit tests. Run before every commit.                         |
| `npm run verify:full`      | `verify` plus `test:integration`. Run at a batch boundary.                                             |

## Stack

Next.js (App Router) + React + TypeScript on the client; PostgreSQL with row-level security via Supabase for storage, auth, and the hydration/write RPCs; a Deno edge function plus Resend for transactional email; Vercel for hosting. ESM throughout, with `strict` and `noUncheckedIndexedAccess` on. See [`CLAUDE.md`](CLAUDE.md) for the conventions this codebase holds itself to.
