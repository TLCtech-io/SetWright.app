# 006 member self-service RPCs

Covers `20250101000006_rpc_member.sql`: `set_my_availability`, `set_my_confidence`,
`update_my_profile`. Why they sit apart, what each one is protecting against, and where the
obvious change breaks something.

## Why they are a separate trust class

Every other write path in the schema is a policy decision. These three are not.

All three are `SECURITY DEFINER` owned by `postgres`. That role is not a superuser here, but it
holds `BYPASSRLS` and owns the tables, and no table sets `FORCE ROW LEVEL SECURITY`. So no policy
runs inside these bodies. The `where` clause of each statement is the entire access rule. The
director RPCs in 005 are the opposite: `set_availability` and `set_song_casting` are both
`SECURITY INVOKER` and lean on RLS plus the tier helpers.

Grouping them in one file keeps that visible. Three unguarded functions scattered through a file
of guarded ones read like the rest of the file, which is the failure mode.

Execute is granted to `authenticated` only. The ACL on all three is
`{postgres=X/postgres,authenticated=X/postgres}`, so a service-role client calling one gets
permission denied. These are not an admin path and cannot be turned into one by key choice alone.

`DEFINER` does not change `auth.uid()`. It reads the `request.jwt.claims` GUC, so it stays the
calling member. Two things depend on that: the self checks in these bodies, and the casting
confidence guard in 003, which sees these writes as self writes and lets them through.

## The ensemble-active check is not redundant with the policies

Every policy routes through `auth_member_tier`, which resolves only for an active ensemble, so a
suspended or archived tenant is frozen out of shared data. The self-service paths never call that
helper. They authorize on the caller's own member row, and `member.status` stays `'active'` when
the ensemble is archived. Without an explicit check, archiving a tenant would freeze shared
writes and leave self-writes wide open. All three now join or `exists` on `ensemble.status =
'active'`.

Adding it changed nothing for live data: `ensemble.status` defaults to `'active'`, and
reactivation is an admin path that is not exposed. Full reasoning in
`_archive/20250101000025_self_rpcs_ensemble_active.sql`.

## Trap: two of the three fail silently, one raises

`set_my_availability` resolves the member into a variable and raises
`'not an active member of this ensemble'`. `set_my_confidence` and `update_my_profile` are single
UPDATEs whose predicate simply matches nothing. They return void, nothing checks the row count,
and the repository's `unwrap` only surfaces errors. A member of an archived tenant gets a clean
200 and no change.

That is asserted deliberately in `apps/web/test/integration/access.itest.ts`: the call "runs (no
error) even in an archived ensemble" and the name is unchanged afterwards. Anyone adding a fourth
self RPC picks one of these two failure modes, and should pick it on purpose.

## set_my_availability is DEFINER to move a row it does not own

This one is a bug fix, not a convenience.

A member's RSVP writes only the `availability` child table. `moddatetime` is per table, so
`event.updated_at` never moved. The director's bulk save guards on it:
`update event set updated_at = now() where id = p_event and updated_at = p_expected`, returning
`conflict` when it misses. Because the token had not moved, that save did not detect the member's
RSVP, and its replace overwrote it. No error on either side.

The fix is the trailing `update public.event set updated_at = now()`. Now the director's next
guarded save conflicts, returns 409, and reloads. A member cannot update the event row under the
director-only `event_write` policy, so the function had to become `SECURITY DEFINER` to do it.

The cost is stated plainly and worth keeping: the function gave up RLS as a backstop in order to
buy a correct concurrency signal. Its internal checks are now the only gate. They were not
widened to pay for it. It still resolves the caller's own active member row, writes only that
member's availability row, and touches `updated_at` on the one event just RSVP'd to.

**The archive contradicts itself here.** `_archive/20250101000020_set_my_availability.sql` and
`_archive/20250101000025_self_rpcs_ensemble_active.sql` declare it `SECURITY INVOKER` and say so
in prose. `_archive/20250101000053_self_rpc_concurrency.sql` flipped it, and that is what the
catalog holds. Do not quote the older two on the trust model.

## Trap: the RPC is not the only way to write an RSVP

`authenticated` holds table-level insert, select, update and delete on `availability`, and
`availability_write` still carries the `auth_is_self(member_id)` branch. A member writing their
own row directly through the Data API therefore succeeds, and that write does not advance
`event.updated_at`. The lost update the DEFINER hop closes reopens on that path.

The app only ever goes through the RPCs, so this is latent, not live. It is the same shape as the
note in 003 about a director's table grant: the app layer alone cannot protect a table the client
role can write.

## set_my_confidence takes a part id, and that is load-bearing

The original signature was `set_my_confidence(p_casting uuid, ...)`
(`_archive/20250101000002_rls.sql`). The client resolved its casting id in one round trip and
wrote it in the next. A concurrent director casting save delete-and-reinserts those rows with
fresh ids, so the pre-resolved id went stale and the member's update matched zero rows. Silent:
no error, no write. `_archive/20250101000053_self_rpc_concurrency.sql` dropped and recreated it
taking `p_part`.

Resolving by part plus the caller's member inside one statement removes the id that could go
stale between round trips. **It does not make the write certain.** `set_song_casting` snapshots
prior confidence keyed `part:member` *before* it deletes, then re-inserts from that snapshot. A
member update that commits after the snapshot and before the re-insert is overwritten by the
stale value. The function returns void, neither it nor the caller checks a row count, so that
loss is still silent. What the single statement buys is that the common case stops failing, not
that the race is gone.

## Trap: do not reintroduce the old signature

Both versions are `(uuid, text)`, so the argument types collide exactly.

`create or replace function set_my_confidence(p_casting uuid, p_confidence text)` fails loudly:
Postgres raises `cannot change name of input parameter "p_part"`. That is verified against the
live catalog, and it is why 053 had to `drop function` first.

A `drop` plus `create` does not fail. It replaces the live function with one that means something
different, and nothing else in the schema references the parameter name, so nothing else
notices. The failure surfaces as members' confidence writes going nowhere.

## Column ownership around self_reported_confidence

The director owns a casting's assignment and `director_assessed`. The cast member owns
`self_reported_confidence`. RLS is row-level and cannot exclude one column, so the split is
enforced by the `casting_confidence_owner` trigger in 003 rather than by a policy.

On UPDATE the trigger keeps the old value whenever someone other than the cast member changes the
column. `set_my_confidence` passes because `auth.uid()` is still the member.

The INSERT branch is subtler. Nulling the column on every non-self insert would break
`set_song_casting`, which re-inserts each casting carrying the member's preserved prior value
while running as the director. That path vouches for itself with the transaction-local GUC
`app.casting_writer = 'rpc'`, set with `is_local = true` so it cannot leak across a pooled
connection. A raw director insert is a different transaction, carries no flag, and is guarded.

Two consequences worth holding on to:

- If any of these three functions were ever changed to write on someone else's behalf, the guard
  would start silently reverting the column while the function still returned void as though it
  had worked.
- `auth_is_self` itself requires an active member row *and* an active ensemble. In an archived
  tenant the trigger therefore treats even the member's own direct casting write as foreign and
  reverts the confidence.

## update_my_profile writes member, not app_user

The `where` clause is the whole authorization: `m.id = p_member and m.user_id = auth.uid()`, plus
the member-active and ensemble-active checks. Tier, status and the account link are not reachable
through the function, which is the point of routing profile edits through it instead of a table
write. The route resolves the member id from the caller's own membership and never takes it from
the body.

`display_name` coalesces because the column is NOT NULL and a null argument means "leave it
alone". The two range columns are set directly, so a null argument clears them. That asymmetry is
deliberate and reads like an oversight.

One correction to carry forward. `_archive/20250101000055_platform_admin.sql` justifies narrowing
`authenticated` on `app_user` by saying profile edits go through this RPC. The narrowing itself
holds today: `authenticated` has no table-level UPDATE on `app_user`, only column privileges on
`email` and `display_name`, so `is_platform_admin` is unwritable by that role. But this RPC
updates `public.member`. The display name a member edits here is the member-row name, and
`app_user.display_name` is a separate field. The narrowing is right, the sentence about which
table is not.

## Small things that are decisions, not accidents

**No ensemble argument on set_my_confidence.** It takes a part id alone. Scope comes from
`casting.member_id` having to resolve to a member row owned by `auth.uid()`, and from the unique
`(member_id, part_id)` on casting, so at most one row per caller per part is in range. The
missing ensemble argument is not a hole, and adding a caller-supplied one would introduce a scope
the request body currently cannot influence.

**Status validated twice.** `set_my_availability` rejects a status outside
`('in','out','tentative')` before it touches anything, and `availability_status_check` enforces
the same domain. The early raise buys a named error instead of a constraint violation.

**Confidence validated once.** `set_my_confidence` does not check `p_confidence`. The
`casting_self_reported_confidence_check` constraint does, and it is null-permissive, which is how
"un-report" works.

**Search path.** All three pin `set search_path = pg_catalog, pg_temp` and schema-qualify every
table. They are not the hydration functions in 004, which carry `public` on the path because
their bodies name tables bare. An unqualified table reference added here fails at call time, not
at parse time.

## Ordering

Depends on the tables from 001, including the `(member_id, event_id)` unique key that
`set_my_availability` upserts against, and on the confidence guard trigger from 003 existing so
the trust model above holds. These three call no helper defined in 002.
