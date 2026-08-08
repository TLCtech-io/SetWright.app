# CLAUDE.md

SetWright is a living repertoire system that drafts vocal set lists. The director keeps the artistic call. The tool does the bookkeeping a director botches by hand: who is available, who covers each part, what is performance-ready, and what fits the night. It is a commercial product, so nothing in the data layer assumes one group.

## Repository

A TypeScript monorepo. One language top to bottom, the same types from the database to the API to the clients.

```
packages/
  core/   domain types and the set drafter. Pure logic, no storage, no transport.
  db/     a parse harness that validates the SQL in supabase/. Holds no SQL itself.
  api/    a thin library over the drafter. Not an HTTP server.
apps/
  web/    the Next.js app. Director, member, and platform-admin consoles, plus the
          route handlers under app/api that back them. Most endpoints live here,
          not in packages/api.
supabase/
  migrations/  the canonical SQL, applied in order. Alongside it: seed.sql,
               test-reset.sql, config.toml, the auth email templates, and the
               send-email edge function.
  decisions/   one record per baseline migration: why the SQL is shaped that way.
scripts/  repo checks that gate CI, plus the auth email template generator.
```

`mobile` comes later. `core` is the heart and depends on nothing infrastructural, so it runs and tests in isolation.

## The cardinal rule

The schema is the contract, and it is eight files:

```
20250101000001_schema.sql        tables, constraints, indexes
20250101000002_rls.sql           auth helpers, grants, policies, casting_visible
20250101000003_guards.sql        trigger functions and their triggers
20250101000004_hydration.sql     the two hydration functions
20250101000005_rpc_director.sql  curated write RPCs
20250101000006_rpc_member.sql    self-service RPCs a member calls on their own rows
20250101000007_rpc_platform.sql  provisioning, invites, founding credits, admin
20250101000008_comments.sql      catalog comments
```

Every object is declared exactly once, at its final state, so the file you grep is the file in force. Read them in order: the auth helpers in 002 are what break the RLS recursion, and everything above 002 depends on them.

The domain types in `core` match the schema. Do not write a translation layer between database rows and the domain types, and do not let the two drift. When a shape needs to change, change the schema and the types together.

Applied migrations are immutable, the baseline included. Never edit one, add a new migration. The series is hand-maintained `20250101000NNN_name.sql`, so take the next number by hand, starting at 009. Do not use `supabase migration new`; it stamps a real timestamp and breaks the ordering. A hook blocks edits to all eight baseline files.

`supabase/migrations/_archive/` holds the 64 migrations this baseline replaced. They are never applied: the Supabase CLI does not recurse into subdirectories, and the repo scripts that enumerate migrations read the directory non-recursively. The reasoning behind the schema is recorded in `supabase/decisions/`, one file per baseline migration. The archive is kept because it holds the full original text behind anything a record only summarises, and a good deal of that is not recoverable from the result. Read either when you need a reason, not when you need the current state. Where they disagree, the running code wins, then the baseline SQL, then the records, then the archive. Several archive headers were already contradicted by later migrations before the archive was made, so treat any one file as intent on the day it was written.

Pitch and key conversion lives in exactly one module, `core/src/pitch.ts`. Pitch is MIDI, middle C is 60. Key is fifths plus mode. Tempo is bpm. No conversion logic anywhere else.

## The boundary

SQL reduces; TypeScript decides. There are two hydration functions, both in `20250101000004_hydration.sql`: `hydrate_draft_input` and `hydrate_setlist_locks`. Their `search_path` is pinned to `pg_catalog, public, pg_temp`, which differs from every other function in the schema because their bodies name tables unqualified. Redeclaring one resets its configuration, so a redeclaration has to carry that exact value. They do set-based work with fixed predicates: resolve policy, pull the active pool, project the rows the drafter needs. They do not gate. Every gate (feasibility, readiness, context) runs in `core`, because the shortfall explains a drop only for songs the core sees. The only filters SQL applies are `status = 'active'` and, on the member pool, `is_singing`.

Queries run RLS-scoped as the signed-in member. The hydration functions are called with the user's client, never the service-role key. Tenancy is enforced at this boundary, so `core` carries no `ensemble_id` and stays tenant-agnostic.

The service-role client does exist, in `apps/web/lib/supabase/admin.ts`. It is for auth-admin work only, in the invite and resend paths. It never queries a tenant table directly, and no code may make it do so. It does have one elevated data path: the unauthenticated resend route reaches two `SECURITY DEFINER` RPCs granted to `service_role`, `refresh_pending_invite` and `consume_invite_quota_by_email`. Note where the elevation comes from. `SECURITY DEFINER` is what bypasses RLS; the key only gates who may call. Both take the target email as a scalar from the request body, so a caller does pick which row the elevated statement touches. What a caller cannot do is widen the predicate: its shape is fixed in SQL, neither accepts a filter expression, and neither returns another tenant's data. That bounds the blast radius to a single address. Add another only on those terms.

## The drafter

A funnel. Each song falls out at the first gate it fails.

```
ALL SONGS -> feasibility -> readiness -> context -> select + sequence
```

Feasibility is a hard gate and an assignment problem: can the available, cast singers cover every required part at the count it needs, given that one singer fills one line at a time. It is real matching, not a headcount. Readiness and context are soft and tunable. Selection fills to the target, biased under, and sequence lays out a starting arc the director finishes. When the pool falls short, the drafter names the lever, not a dead end.

## Request handling and security

Untrusted request bodies never reach a repository call directly. Most write routes coerce their payload through a `lib/*Input.ts` module that returns `{ ok: true, value }` or `{ ok: false, error }`, which the handler turns into a 400. Ten route files still assert a body shape and check the fields inline: the six under `setlist/[setlistId]`, both `/api/ensembles` routes, the event setlist create and the playground link. Array and body sizes are capped in `lib/limits.ts`. Add a coercer for a new write shape rather than validating inline in the handler, and treat those ten as the pattern to replace, not the one to copy.

CSRF uses no token. The session and `active_ensemble` cookies are `SameSite=Lax`, so a cross-site write never carries them, and `lib/csrf.ts` refuses any mutating `/api` or `/auth/signout` request whose browser-set Origin or Referer names a different host. Do not loosen those cookies to `SameSite=None`, and add any new mutating route outside `/api` to `isProtectedPath`. The gate exempts GET, HEAD and OPTIONS before it consults that list, so it does not cover a state-changing GET, and the codebase has one: `/auth/confirm` claims invited seats and can seed an ensemble. Its protection is the single-use token it verifies first, not this gate. A new mutating GET needs its own equivalent, because adding it to `isProtectedPath` would do nothing.

`next.config.ts` sets baseline security headers on every response: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and a CSP limited to `frame-ancestors`, `object-src`, and `base-uri`. There is no `script-src` yet because Next inlines scripts. Adding one is a real change with a real cost, not a tidy-up.

## Stack and conventions

- ESM throughout. In `packages/*`, `module` and `moduleResolution` are NodeNext, so relative imports carry the `.js` extension. `apps/web` is the exception: it is a standalone tsconfig on `esnext`/`bundler`, and its relative imports are extensionless. Follow the convention of the package you are editing.
- The `core` and `api` packages publish TypeScript source as their entry points (`exports` points at `src/index.ts`, whose internal imports use `.js` specifiers). Only a TypeScript-aware consumer resolves that: Next (via `transpilePackages`) and `tsx` for tests. Nothing here consumes them any other way, and there is no compiled `dist` in the consume path. `core` is the only package that can emit one, through a `build` script nothing runs; `api` and `db` set `noEmit` and have no `build` at all. A plain-Node consumer is therefore not a supported path today. Both packages are `private`, so this never ships to a registry; it is a deliberate workspace convention, not an oversight.
- `strict` and `noUncheckedIndexedAccess` are on. Respect them.
- Primary keys are uuid v4, generated by the database. Every write omits `id` and reads it back from the insert, so nothing in the app layer mints one. The schema header states a preference for app-layer v7 for index locality; that was never built. Do not order by `id` expecting creation order, and do not write code that assumes it. `public_id`, the URL-facing token, is the one id the app does mint (`apps/web/lib/publicId.ts`).
- Tests run as plain `tsx` scripts with `node:assert`. Keep them dependency-light unless there is a reason not to.
- npm workspaces. Each of `packages/*` has its own `package.json` and a `tsconfig.json` that extends `tsconfig.base.json`. `apps/web` does not extend it. Web hand-redeclares the shared options and adds `noUnusedLocals` and `noUnusedParameters`, so an edit to `tsconfig.base.json` does not reach the bulk of the code.
- Two verification tiers. `npm run verify` is the offline gate: typecheck, `email:check`, build, and every workspace's unit tests. `typecheck` runs in every workspace that defines one, so each package's sources and its test files are checked directly, not just the subset `apps/web` reaches through imports. Running a test with `tsx` does not typecheck it, so this gate is the only thing that does. `email:check` re-renders the auth emails from `supabase/functions/_shared/email/` and fails when `supabase/templates/*.html` or the `config.toml` subject lines have drifted from it, so edit the copy module and regenerate with `npm run email:build` rather than editing the generated HTML. `build` stays scoped to `apps/web`. When you add a unit test file, add it to the workspace's `test` script by hand or it runs nowhere; `scripts/check-test-registration.mjs` fails CI when you forget. That check reads `*.test.ts` only, so integration domains are outside it: they are registered by hand in `apps/web/test/integration/run.ts` and nothing checks that list.
- `npm run verify:full` adds `test:integration`, which needs the local Supabase stack up (`supabase start`). `npm run test:e2e` runs Playwright against that same local stack plus a Chromium install: the config reads the stack's URL and keys from `supabase status`, then builds and starts a production Next server on port 3210 itself. It is not part of `verify:full`, so it runs by hand or in CI. Run the offline gate before every commit; run the live gate at a batch boundary.
- Running the app. `npm run dev` sets `DATA_SOURCE=mock` and serves from the in-memory store in `apps/web/lib/db.ts`, not Postgres. That store is per-process module state, seeded once and reset on restart, so two dev servers never share data. Set `DATA_SOURCE=supabase` to exercise the real path. Next 16 is pinned to webpack: `dev` and `build` both carry `--webpack`, because only webpack's `extensionAlias` maps `core`'s `.js` specifiers back to `.ts`.
- Routing and the session gate. Console URLs are `/e/:publicId/...`, carrying the opaque `public_id` token, never an internal uuid. The Next route param is named `[ensembleId]`, which is misleading; it holds the token. Every `/api/e/...` handler opens with `repoForRoute()` and guards inner uuid segments with `badPathUuid()`. Auth, tenancy, and the platform-admin gate live in `apps/web/proxy.ts` (Next 16's rename of middleware), which is a pass-through in mock mode.

## Branches and CI

Branches flow feature to `prod-staging` to `main`. `prod-staging` is the integration branch and the default PR target. `main` is production, and the `promotion-guard` job fails any PR into it from anything other than `prod-staging`.

CI runs three tiers: `verify` (offline), `integration`, and `e2e`, the last two against a Docker-backed Supabase stack. It pins Node 22 and the Supabase CLI, and the CLI pin moves together with the `supabase` devDependency.

Three more workflows gate a PR. `codeql.yml` analyses `javascript-typescript` and `actions` on the security-and-quality suite, on every PR, on push to the two protected branches, and weekly on cron. `dependency-review.yml` fails a PR that introduces a dependency carrying a high-severity advisory; it compares base and head manifests, so it sees only what the PR changes. `shellcheck.yml` lints every tracked `.sh` at warning severity, because a quoting bug in a guard script fails open. `dependabot.yml` opens grouped weekly npm and github-actions PRs and holds the by-hand exceptions: the `supabase` CLI pin has to move with `ci.yml`, and `typescript` and `@types/node` majors are taken deliberately.

Three repo checks run before the suite. `scripts/check-config-safety.sh` guards the `[auth.rate_limit]` block in `supabase/config.toml`, which is relaxed for the local integration suite: it fails the build if any workflow or script invokes `supabase config push` or `db push`, or if the `config-safety-guard` marker is removed while the relaxed values remain. Hosted auth limits are set in the Supabase dashboard and are never pushed from that file. `scripts/check-test-registration.mjs` catches test files that exist but are not wired into their workspace's `test` script. `scripts/check-search-path-pins.mjs` walks the migrations in order, models the final state of every function, and fails when one ends up with no pinned `search_path`; `create or replace function` clears an earlier pin, so this is what catches a redeclaration that drops one.

## How to work here

- Reason through tradeoffs briefly, then build. State decisions plainly and name what they cost.
- Hold scope. Build the slice at hand, not the next three.
- Keep the `core` test suite green; it is the fast feedback loop that `db`, `api`, and `web` build on.
- `.claude/settings.json` and `.claude/hooks/` are committed, because they enforce rules this file only states. One hook blocks edits to the locked base migrations; the other runs the core suite after any `packages/core` edit and feeds failures back. Both need `jq` on PATH, and the core-suite hook also needs `npm ci` to have run. Without `jq` neither can read the file path out of its input, and both exit 0 rather than failing, so the baseline lock stands down with no message. Personal settings and the local launch config stay untracked.

## Writing style

For comments, docs, and commit messages: short to medium sentences, plain English. Lead with the point. Name tradeoffs. No em dashes. No filler transitions like moreover, furthermore, additionally. No buzzwords: leverage, seamless, robust, transformative, holistic, journey, game-changing. Markdown follows standard conventions.
