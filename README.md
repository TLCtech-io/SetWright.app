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
  migrations/   the schema, RLS policies, and hydration/write RPCs (64 migrations)
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

## Deploying

`supabase/config.toml` configures the **local** stack only. It is never pushed, and `scripts/check-config-safety.sh` fails the build if any script or workflow tries: the auth rate limits in it are deliberately relaxed so the integration suite can run without tripping them, and shipping those to a hosted project would permit credential stuffing. Everything below is therefore set by hand, once, in a dashboard.

No test tier covers any of it. Local development is arranged so it cannot: the Send Email hook is off locally so GoTrue renders the templates in `supabase/templates/` into Mailpit, which means the hosted email path only ever runs in production. Two production breakages have come from this gap, so treat the order below as load-bearing rather than a checklist to skim.

Find `<project-ref>` in your Supabase project URL.

### 1. Schema

Migrations are applied by hand. Nothing in CI applies them.

```bash
supabase link --project-ref <project-ref>
supabase db push
```

`supabase migration list --linked` prints local and remote side by side. Every row should match before you go further.

### 2. Auth email

Auth email is delivered by the `send-email` edge function, not by Supabase's built-in templating. The order matters: the hook 404s until the function is deployed, and the function refuses every call until its secret is set.

```bash
supabase functions deploy send-email --project-ref <project-ref>
```

Then **Authentication > Hooks > Send Email**: enable it and point it at `https://<project-ref>.supabase.co/functions/v1/send-email`. Saving generates a secret beginning `v1,whsec_`. Copy it, then set all three function secrets:

```bash
supabase secrets set --project-ref <project-ref> RESEND_API_KEY=... SEND_EMAIL_HOOK_SECRET=v1,whsec_... SEND_EMAIL_FROM="SetWright <noreply@yourdomain>"
```

| Secret | Where it comes from | Left unset |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `RESEND_API_KEY` | Resend, API Keys | Every send fails. |
| `SEND_EMAIL_HOOK_SECRET` | Generated by the hook screen above | The function returns 500 to every call and no auth email is ever sent. |
| `SEND_EMAIL_FROM` | A sender on a domain you verified in Resend | Falls back to Resend's shared sandbox, which delivers only to the Resend account owner. |

That last fallback is the one that wastes an afternoon: invites appear to send and silently reach nobody but you. Verify a domain in Resend before testing with a second address.

Enabling the hook takes GoTrue's own templating out of the path completely, and the dashboard's email editor goes dead. The files in `supabase/templates/` are the fallback for a project running **without** the hook; paste them into **Authentication > Emails** if you ever disable it. Do not hand-edit them, they are generated by `npm run email:build` and `npm run email:check` fails the build on drift.

### 3. Auth settings

**Authentication > URL Configuration** first, because it is the most load-bearing setting in the project. The app never passes a `redirectTo`, so GoTrue fills the link origin from Site URL, and every invite, magic link and recovery link is built against it. Wrong or unset and the links point somewhere that cannot verify them.

| Setting | Where | Value |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| Site URL | Authentication > URL Configuration | Your app origin, no trailing slash |
| Redirect URLs | Authentication > URL Configuration | The same origin, plus `/**` |
| Confirm email | Authentication > Sign In / Providers > Email | On. Off means a pre-registration can claim a seat. |
| Minimum password length | Authentication > Sign In / Providers > Email | 8, matching the copy on `/auth/welcome` |
| Password requirements | Authentication > Sign In / Providers > Email | Letters and digits, matching the same copy |
| Secure password change | Authentication > Sign In / Providers > Email | On |
| Secure email change (double confirm) | Authentication > Sign In / Providers > Email | On |
| Rate limits | Authentication > Rate Limits | Production values. The local file's are relaxed for CI. |

### 4. The web app

Vercel project settings, environment variables, set for Production:

| Variable | Notes |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `DATA_SOURCE` | `supabase`. Needed at build and at runtime. |
| `NEXT_PUBLIC_SUPABASE_URL` | Needed at build time, since Next inlines it. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon key. A secret key here ships to every browser and bypasses RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never give it a `NEXT_PUBLIC_` prefix. |
| `PUBLIC_SIGNUP` | Leave unset for invite-only. `true` reopens public registration. |
| `ALLOW_PRODUCTION_MOCK` | Leave **absent**. Set, it serves the unauthenticated in-memory store. |

Node 22, matching CI. The custom domain must match Site URL in step 3 exactly.

### 5. Not on by default

None of these are required to make the app work, which is why they are easy to leave. Each is a dashboard setting with no representation in this repo.

- **Database network restrictions** (Project Settings > Database). The default allows `0.0.0.0/0`, so Postgres is reachable from any address and the password is the only control.
- **SSL enforcement** (Project Settings > Database). Off means the server accepts an unencrypted connection if a client asks for one.
- **MFA** and **captcha** (Authentication). Both off by default. A director tier can rewrite an ensemble's repertoire.
- **A rate-limit rule on `/api/auth/resend`** (Vercel Firewall). That route is unauthenticated by design. The database bounds what it writes; nothing in the app bounds how often it can be called.

## Stack

Next.js (App Router) + React + TypeScript on the client; PostgreSQL with row-level security via Supabase for storage, auth, and the hydration/write RPCs; a Deno edge function plus Resend for transactional email; Vercel for hosting. ESM throughout, with `strict` and `noUncheckedIndexedAccess` on. See [`CLAUDE.md`](CLAUDE.md) for the conventions this codebase holds itself to.
