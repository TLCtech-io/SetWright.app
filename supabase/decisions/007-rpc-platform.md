# 007 Provisioning, invites, credits, and the platform admin

Why `20250101000007_rpc_platform.sql` is shaped the way it is. The file itself records what each
function does. This records the reasoning a reader cannot recover from the object, the tradeoffs
that were measured, and the places where the obvious change is wrong.

The migrations this file replaced are in `supabase/migrations/_archive/`. The ones that matter
here are 008 (`onboarding_seed`), 010 and 028 (function cleanups), 019/022/047 (`member_invite`),
026 (founding quota), 030/043 (claim by verified email), 050 (`public_id`), 052 (invite
reactivation), 055 (platform admin), 056 and 061 (rate limiting), 057 (founding credit), 060, 063
and 064 (binding consent and expiry).

## Bootstrapping the first platform admin

Nothing in the repository writes `app_user.is_platform_admin`. There is no route, no RPC, and no
admin screen that grants it. That is deliberate, and it means the first admin on a fresh deployment
is created by hand.

The procedure:

1. In the Supabase web GUI, go to Authentication, Users, Add User, Create New User.
2. Supply a real email address and a password, with "Auto confirm user?" selected.
3. From the dashboard SQL Editor, run:

```sql
update app_user set is_platform_admin = true
where id = (select id from auth.users where lower(email) = lower('<platform-admin-email>'));
```

Step 1 is what creates the `app_user` row. The `on_auth_user_created` trigger on `auth.users` runs
`handle_new_user()`, which inserts `(id, email, display_name)` into `app_user`. Step 3 then has a
row to update. Running the update before the user exists silently affects zero rows.

Auto confirm matters because an unconfirmed account cannot accept an invitation:
`accept_invitation` and `list_pending_invitations` both require `email_confirmed_at is not null`
read straight from `auth.users`.

### Why it has to be direct SQL

The two granting RPCs cannot do this job, for two independent reasons.

`grant_founding_credit` and `grant_founding_credit_by_email` both open with
`auth_is_platform_admin()`, and that function resolves the caller through `auth.uid()`. A SQL
console has no GoTrue session, so `auth.uid()` is null, the lookup returns nothing, the `coalesce`
yields false, and the call raises `not a platform admin`. There is no way to call them from a SQL
editor. Neither grants the admin flag anyway; they only move `founding_credits`.

The direct write also cannot be done from the app. `authenticated` holds UPDATE on `app_user` for
`email` and `display_name` only. Column privileges are checked independently of RLS, so the
`app_user_update` policy (`id = auth.uid()`) authorizes the row while the column grant refuses the
column. A PostgREST PATCH of `is_platform_admin` on your own row is rejected. Migration 055
introduced that narrowing, and `apps/web/test/integration/adminrate.itest.ts` exercises the
self-promotion vector directly.

### service_role cannot do it either

A common assumption, and wrong. `service_role` holds only REFERENCES, TRIGGER and TRUNCATE on
`app_user`. It has no SELECT, no INSERT and no UPDATE, on any column. It cannot read the table, let
alone write the flag. The write is available to a superuser or table-owner connection, which in
practice means the `postgres` role behind the dashboard SQL Editor, and to nothing else.

The same is true of `founding_credits`. Every write to it goes through a definer function owned by
`postgres`.

### Trap: the INSERT grant is wider than the UPDATE grant

`authenticated` holds table-level INSERT and DELETE on `app_user`, and the INSERT column privileges
cover every column including `is_platform_admin` and `founding_credits`. The only thing stopping a
client from inserting a pre-promoted row is that `app_user` has exactly two policies, both for
SELECT and UPDATE. With RLS on and no INSERT policy, the insert is denied.

So adding an INSERT policy to `app_user`, for any reason, opens self-promotion. `handle_new_user()`
is `SECURITY DEFINER` and does not need one. If a future path genuinely needs a client-side insert,
narrow the column grant first.

## Why almost everything here is SECURITY DEFINER

The reasons are not interchangeable, and swapping one function to invoker on the strength of
another's reason will break it.

- **Reaches `auth.users`.** `ensemble_seat_for_email`, `grant_founding_credit_by_email`,
  `accept_invitation`, `list_pending_invitations`. A client role cannot see the email to user_id
  map at all.
- **Writes a column `authenticated` cannot write.** `grant_founding_credit`,
  `grant_founding_credit_by_email`, `consume_founding_credit`. See the column grant above.
- **Writes before any membership exists to authorize it.** `create_ensemble_seeded` inserts the
  ensemble and its first director in one transaction. There is no member row yet for a policy to
  match.
- **Bypasses RLS on a deny-all table.** `consume_kind` and its two wrappers. `invite_rate_event`
  has RLS on, zero policies, and no grants to any client role.
- **Reads for someone who has no member row yet.** The three invitation functions plus
  `refresh_pending_invite`. An invitee is invisible to `member_read`, `ensemble_read` and
  `member_invite_read`, so without a definer reader the accept screen renders nothing. These four
  are the whole set of definer readers that bypass `member_invite_read` today.

`set_member_status` is the one invoker function in the file, on purpose. The director's own
`member_invite_write` policy is what authorizes the invite delete, so the write stays inside the
tenancy the caller already holds. `prune_member_coverage`, which it calls, is invoker too.

## The two service_role grants

`consume_invite_quota_by_email` and `refresh_pending_invite` are the only two functions in the
schema granted to `service_role`. Both exist for one caller, the unauthenticated resend route at
`apps/web/app/api/auth/resend/route.ts`, where `auth.uid()` is null and no authenticated path is
available.

Get the split of duties right before adding a third. `SECURITY DEFINER` is what bypasses RLS. The
key only gates who may call. The safety of the pair does not come from the key; it comes from the
shape of the statement underneath it.

Both take the target email as a scalar, so a caller does pick which row the elevated statement
touches. What a caller cannot do is widen the predicate. The shape is fixed in SQL, neither accepts
a filter expression, and neither returns another tenant's data. That bounds the blast radius to a
single address. A third grant has to meet the same terms.

Keeping them off `anon` is a separate concern from keeping them definer. On `anon`, a browser could
burn a victim's resend quota directly, and `refresh_pending_invite`'s boolean would become an
enumeration oracle for which addresses hold pending invites. The route never returns that boolean:
it always replies with the same message, and sends the email in `after()` so response latency does
not leak the answer either.

## Rate limiting

The counter lives in Postgres because in-memory limiting does not hold on Vercel Fluid Compute.
State is per instance and resets on a cold start, so a limit enforced in process is not a limit.

The ceiling for each kind is server defined, never an argument. A client-supplied window would let
a caller pass something tiny so the count comes back near zero; a client-supplied limit would let
them widen their own bucket. The wrappers take only the kind, the engine resolves limit and window
itself, and an unknown kind returns zero allowance, so it fails closed.

### The sweep was measured and changed

Archive 056 swept expired rows on roughly 1% of calls and its own comment called that amortized and
cheap. Archive 061 says plainly that the comment was wrong, and gives two reasons.

The sweep only runs inside a request, so cleanup is coupled to traffic. A burst that stops leaves
its rows behind until roughly a hundred more organic calls arrive, which at realistic resend volume
is weeks. And the unlucky real user whose call drew the 1% branch paid to delete the entire backlog
synchronously inside a serverless function, while the anonymous caller who created the backlog paid
nothing.

Sweeping a fixed 50 rows on every call inverts that. Drain (50 per call) exceeds creation (at most
1 per call), so the table is bounded by roughly an hour of accepted traffic rather than by how
recently someone got unlucky, and no single caller pays for the whole backlog.

056 is immutable, so the correction lived in 061 and only the 061 body survives in the baseline. If
you grep for the "~1% of calls" language and cannot find it, that is why.

### Two details in the sweep that look incidental and are not

`delete ... where id = any (array(select ... for update skip locked))` is written that way
deliberately. It plans as a locked index scan on `invite_rate_event_created` feeding a bitmap probe
on the primary key. The equivalent `delete ... using` seq-scans the outer side, which is the wrong
shape on exactly the backlog the sweep exists to drain.

The sweep runs before `pg_advisory_xact_lock`, not after. 056 had a per-subject prune sitting after
the lock. It contributed nothing to the ceiling, because the count is already time-filtered, and
combining it with a sweep that row-locks arbitrary rows before taking the advisory lock closed a
deadlock cycle. With it gone, the only writer contention left is sweep against sweep, which `skip
locked` handles.

Note the consequence: the sweep is housekeeping and has no effect on whether a call is allowed.
Changing 50 to some other number changes table size, not the limit.

### What no database ceiling can do

Nothing here bounds request volume, function invocations, or pooler connections. That is a platform
rate-limit rule on `/api/auth/resend`, keyed by IP.

A global hourly ceiling was considered and rejected. It would be consumed before the per-email
check, so a few hundred requests would switch off self-serve invite recovery for every real user.
That trades a bounded, reclaimable table for an outage of the account-recovery path.

## Founding credits

The gate had to live in SQL. `create_ensemble_seeded` is directly callable through PostgREST, so
closing the `/ensembles` UI would have closed nothing. Before archive 057, any authenticated
account could found an ensemble for free, which is the exact door the invite-first, director-pays
model has to control.

`grant_founding_credit`'s `where founding_credits = 0` predicate does three jobs at once:

- **It prevents stacking.** Supabase `inviteUserByEmail` re-invites an unconfirmed account by
  returning the *same* user, so a re-sent invite would otherwise grant a second credit and buy a
  second free ensemble.
- **It is concurrency-safe**, by row lock plus re-check.
- **It makes the invite route retry-safe.** A re-POST after a lost response finishes authorizing
  without over-granting. The route relies on this: it tells the admin to submit again when the
  grant fails after the email is already out.

A genuinely new authorization still works, because accepting spends the credit back to zero.

`grant_founding_credit_by_email` resolves the id against `auth.users` rather than `app_user.email`.
The mirror is not usually stale: `handle_user_email_change()` fires on `auth.users` email updates
and keeps it current (see file 003). But it is a mirror maintained by a trigger, and reading the
source directly costs nothing and does not depend on that trigger firing. `order by created_at
limit 1` guards a duplicate address.

The 20-owned quota comes from archive 026 and predates credits. It stays as a backstop. Its
reasoning: unbounded seeded-vocabulary creation is a cheap amplification DoS on a multi-tenant
service, and 20 is far above a real director's needs, most of whom run one to three. Archive 028
added the advisory lock, because count-then-insert let concurrent calls all pass. The lock key is
`hashtextextended(v_uid::text, 0)`, so it serializes one account against itself and never against
another user.

### create_ensemble must stay dead

The bare, vocabulary-less founder has a history worth not repeating. It was dropped in archive 010
because it minted an unusable tenant, accidentally resurrected by 026 (which recreated both
founders to add the quota), and dropped again in 028. It is absent from the current catalog and
must stay absent. No `drop function` statement is needed in the baseline, since nothing creates it.

## Invitation consent

The problem archive 064 names: `/auth/confirm` called `claim_membership()` on every verified
confirm of any type, and that bound *every* pending seat matching the address. A director could
record an invitation for any address they knew, send nothing, and the account was bound the next
time its owner clicked a magic link or reset a password, whatever they were actually trying to do.
Archive 063 bounded how long that stayed possible. It did not make it consensual.

Three functions replace the one. `claim_membership` was dropped rather than left granted, so no
bind-everything path survives for a future caller to reach for.

Each of the three keys on `auth.email()` rather than on an argument. The ensemble id narrows the
set; it cannot widen it. `list_pending_invitations` deliberately repeats every predicate the bind
enforces, so the screen never offers something `accept_invitation` would then refuse.

### Trap: the confirmed-email check is asymmetric

`list_pending_invitations` and `accept_invitation` both require `email_confirmed_at is not null`,
read directly from `auth.users` and independent of the hosted confirmation setting. That is what
stops a pre-registration on someone else's address from accepting their invitation.

`decline_invitation` has no such check. It gates on `auth.uid() is not null` and a case-insensitive
match on `auth.email()`, and nothing more. So an unconfirmed pre-registration on a victim's address
can stamp `declined_at` on that victim's pending invitations. Nothing anywhere clears `declined_at`,
so the refusal is permanent. `accept_invitation`'s own inline comment names this threat model for
the accept path; the decline path does not carry the same defence.

### Trap: a decline is a one-way door

Refusing keeps the row and stamps it rather than deleting it, so the director sees the outcome on
the roster instead of an invitation that appears to be still waiting. That much works.

What does not work is re-inviting. A director re-invite upserts on `member_id`
(`apps/web/lib/supabase/repository.ts`), bumps `invited_at`, and returns success. It does not clear
`declined_at`, and both `list_pending_invitations` and `accept_invitation` require `declined_at is
null`. So the invitee never sees the invitation, `accept_invitation` returns false, and the route
409s. The director has no signal that anything is wrong.

The only way back is to delete the row, which happens on seat removal (`set_member_status` to
inactive) or on member delete. The declined row also holds the
`member_invite_one_per_email` slot for `(ensemble_id, lower(invite_email))`, since that index has no
partial predicate, so the same address cannot be invited onto a different seat in that ensemble
either.

## The absolute expiry anchor

Archive 063's finding: `refresh_pending_invite` sets `invited_at = now()` and is reachable from an
unauthenticated POST. At 3 resends per hour per address, roughly one request a fortnight from
anyone who knows the address keeps a seat bindable indefinitely, and the 14-day expiry never
arrives. The renewal is the feature working. The absence of a ceiling on it was not.

`first_invited_at` is the anchor the resend path cannot move. It is set once on insert and never
written again: `refresh_pending_invite` does not touch it, and the director's upsert does not carry
the column. A genuinely new invitation gets a new row and a fresh anchor, because the row is
deleted on accept and on seat status change. The backfill set it from `invited_at`, which is
generous to rows that already existed rather than retroactively expiring them.

30 days is a little over twice the link lifetime. It covers the case the route exists for, an
invitee returning for a link that expired while they were not looking. Past that, "the invitee is
still trying to accept" stops being the likely reading, and the right remedy is a director
re-invite, which is authenticated and deliberate. Worst-case exposure goes from unbounded to 30
days of renewal plus a final 14-day window. Widening it is a one-word edit.

A director's own resend writes `invited_at` through RLS and never passes through this function, so
the cap does not touch them.

## Invite dead ends

Archive 052's two changes target the same dead end. A person can hold only one seat per ensemble,
so inviting an address that already has one pends forever with no feedback, and archiving a pending
seat left its invite claimable onto an inactive row.

`set_member_status` now deletes the pending invite when a seat is deactivated. Binding onto an
inactive row would land the invitee with no access at all, because `auth_member_tier` requires an
active seat.

`ensemble_seat_for_email` lets the invite flow detect the collision up front and steer the director
to reactivate the existing seat. It answers one question: does this email's account already hold a
seat in this ensemble, and is it active or inactive. Those are the only two values
`member_status_check` allows. The caller in `repository.ts` branches on `active` and treats
everything else as removed. ("archived" is a status on `ensemble`, not on `member`.)

The function is careful about disclosure. It is gated to a director *of this ensemble* through
`auth_member_tier`, so it reveals only a within-ensemble roster fact the caller already has, never
a cross-tenant fact, and never the email of anyone the caller did not just type. A non-director
caller gets an empty result rather than an error.

## gen_public_id is not in this file

It belongs here by subject and is declared in `20250101000001_schema.sql:87`, and only there. Six
tables take `default public.gen_public_id()`, and a default expression is parsed when the column is
added, so the function has to exist before the first of them. Declaring it in both places would be
harmless at apply time and still wrong: one object, one source of truth. This file keeps a note
where the declaration would otherwise sit.

The reasoning behind the function, for the record. The token is an identifier, not a secret; RLS
still draws tenancy. The bytes come from `gen_random_uuid()`, built in on PG13+, so no extension
dependency, and 22 base64url characters carry 122 bits of entropy. `volatile` is load-bearing:
`add column` with a volatile default evaluates it once per existing row, and a non-volatile default
would reuse a single value and fail the unique index. Execute stays with `public`, matching the live
ACL, since a token generator leaks nothing and every insert path reaches it through a column
default anyway.

Six tables carry `public_id`: ensemble, song, member, setlist, event, program. The rest are API
internals that never appear in a URL. The unique b-tree also serves token-to-row point lookups
(`resolvePublicId`, and the proxy's ensemble resolution), so there is no separate lookup index.

## Dependencies out of this file

Everything here depends only on lower-numbered files. `auth_member_tier` and
`auth_is_platform_admin` come from 002, `prune_member_coverage` from 005, and the tables
(`app_user.founding_credits`, `member_invite`, `invite_rate_event`) from 001.

`auth_is_platform_admin` sits in 002 even though archive 055 introduced it alongside the admin flag,
because it is an auth helper and belongs with the others. The `revoke update on app_user from
authenticated` and `grant update (email, display_name)` pair from that same migration is in 002 as
well, with the table grants. That pair is the reason `grant_founding_credit` has to be definer, so
the two files are coupled in intent even though nothing links them syntactically.
