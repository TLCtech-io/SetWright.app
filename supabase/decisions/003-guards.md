# 003 guards: trigger functions, immutability, and the GUC handshake

Covers `supabase/migrations/20250101000003_guards.sql`. The full text of the migrations this
file replaced is in `supabase/migrations/_archive/`; the ones that matter here are 007, 015,
017, 018, 021, 023, 028, 036, 058 and 060.

## Why any of this is in the database at all

The `authenticated` role holds table-level `arwd` on every tenant table. Verified on the live
schema:

```
casting|{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}
```

`member`, `event`, `setlist` and `setlist_item` carry the identical ACL. The director-write RLS
policies have no predicate beyond "director of this ensemble", so any invariant that lives only
in an RPC or a repository method is skippable with one direct PostgREST call.

This was not theoretical. Archive 015 records a live probe deleting a performed setlist and its
four soloist snapshots straight through the RLS-scoped API, with the FK cascade taking the
children. Archive 060 records the same shape against member seats. Every guard in this file
exists because the app was the only enforcer and the Data API was open.

## Why a trigger, and not RLS or column privileges

Three constraints, each ruling out a cheaper option:

- RLS `WITH CHECK` has no OLD row. It cannot express "this column may not change" or "this row
  may not move between tenants". That alone rules RLS out for `guard_member_binding`,
  `guard_event_kind_immutable` and both performed-history guards.
- RLS is row-level. It cannot exclude one column from an otherwise-permitted write, which is
  exactly what `casting.self_reported_confidence` needs.
- Column privileges can do the column job, and the schema uses them elsewhere. `app_user`'s
  UPDATE is pinned to a two-column list at the catalog level (`email` and `display_name` each
  carry `authenticated=w`). That route was considered for `member` and rejected.

The measured cost of the column-privilege route on `member`, from archive 060: the list has to
be re-derived every time a member column is added, and getting it wrong breaks director roster
editing at runtime with a privilege error that no offline gate would surface. A trigger names
the two columns it cares about and is indifferent to the rest of the table. That asymmetry is
why `app_user` and `member` are protected by different mechanisms; it is a deliberate split, not
drift.

## The GUC handshake

Two guards accept a transaction-local vouching flag instead of a role check:

- `app.casting_writer = 'rpc'`, set by `set_song_casting` (archive 017)
- `app.perform_writer = 'rpc'`, set by `perform_setlist` (archive 021)

### Why casting needs one

The obvious fix for the casting INSERT hole is to null `self_reported_confidence` on any
non-self insert. That breaks `set_song_casting`. It snapshots the prior castings keyed by
`part:member`, deletes them all, and re-inserts each one carrying the member's preserved value
as `p.src`, running as the director. A blanket insert guard would wipe every member's
self-report on every director save. So the RPC signals its legitimate re-insert instead.

### What actually bounds the trust

Four things, and all four matter:

- `set_config(..., true)`. The `is_local` argument is load-bearing, not incidental. The setting
  resets at transaction end, so it cannot survive on a pooled connection into another request.
- A raw director write is a different transaction and carries no flag.
- There is no Data API path to set a GUC. PostgREST exposes functions in the `public` schema;
  `set_config` lives in `pg_catalog`, and exactly two public functions set these keys.
- `set_song_casting`'s payload has no confidence field. Rows are
  `{partId, memberId, isPrimary, directorAssessed}`. The flag only ever vouches for a value the
  function read back from the row it just deleted, at the same `part:member` key. A director
  cannot ride the flag to write a confidence value of their choosing.

### The seed is a third holder

`supabase/seed.sql` sets `app.perform_writer` before its one direct flip of the winter set. It
has no director JWT and cannot call the RPC. Worth knowing before assuming the flag is
RPC-exclusive.

### The ordering trap

`perform_setlist` writes the setlist children first and flips the parent to `'performed'` in the
last statement. That single ordering is what keeps both performed-history guards non-blocking on
the legitimate path: at child-write time the parent is still unperformed, and at flip time
`old.status <> 'performed'`. Archive 015 states it, 018 relies on it again when adding INSERT to
the child triggers, and 021 relies on it a third time. Reorder `perform_setlist` and all three
guards start rejecting it. Archive 018 also changed the seed to follow the same ordering.

The status snapshot must be written in the same UPDATE that flips status, for the same reason: a
second UPDATE against a now-performed row raises.

## Performed history took three passes

The final predicate in `guard_performed_child` is hard to read without the sequence:

1. Archive 015 covered UPDATE and DELETE on the children.
2. Archive 018 added INSERT. A fresh row (a new song, a new break ordinal, a new soloist part)
   does not touch the parent setlist row, so the parent guard never fired and the row landed
   inside the frozen record.
3. Archive 021 added the OLD-side check. The guard resolved the parent from NEW only, so a
   director could re-parent a frozen child onto a draft set: NEW points at the draft, the guard
   sees `'draft'`, and the row is silently pulled out of history.

Archive 021 also closed the direct flip on the parent. The guard blocked writes to an
already-performed set but not the transition into it, so a director could PATCH a draft straight
to `status = 'performed'` and produce a performed set with no frozen order, no soloist
snapshots, and a null `performed_date`. The GUC check and the `setlist_performed_has_date` CHECK
constraint in 001 were added together as a pair. Removing either leaves the other doing half a
job.

## The cascade carve-out, and what it really costs

`guard_performed_child` passes when the parent lookup finds nothing. That is the cascade from
deleting a non-performed setlist: the parent row is already gone, so `v_status` is null.

The carve-out is safe, but not for the reason the guards used to give. The old reasoning was
that a performed parent can never be deleted, so a cascade never reaches a performed set's
children. That is wrong, and the schema comment has been corrected. Children of a performed
setlist are reachable by cascade from the other side. `setlist_item` has
`ON DELETE CASCADE` to `song`, so deleting a song cascades into `setlist_item`, the BEFORE
DELETE trigger fires on each cascaded row, and if any of them belongs to a performed set the
whole delete aborts.

The practical consequence, which is the thing a reader needs and cannot see from the function
body: **no song that has ever appeared in a performed setlist can be deleted**, and the director
gets `performed setlist history is immutable` from a DELETE they issued against `song`. The
error names the wrong object. If that is ever surfaced in the UI, translate it at the route.

`setlist_break` and `performance_soloist` are not reachable this way. Their only cascading FK is
to `setlist`. `performance_soloist` in particular has no FK to `song` or `part` in the live
schema, only `ensemble` and `setlist`.

## Column ownership on casting.self_reported_confidence

Archive 007 guarded UPDATE only, and said so explicitly: "INSERT is intentionally not guarded: a
brand-new casting has no prior self-report to overwrite." Archive 017 records a live probe
defeating exactly that with DELETE plus INSERT through the RLS-scoped API. The 007 comment is
superseded, not extended. Do not restore the reasoning.

Two traps in the current body:

- **It coerces, it does not raise.** A director who writes another member's
  `self_reported_confidence` gets a successful response with the value silently nulled (INSERT)
  or reverted (UPDATE). This is the opposite convention from `guard_member_binding`, which
  raises `insufficient_privilege`. The coercion is deliberate, because a director's legitimate
  casting save carries the column and should not fail over it, but it means a client cannot
  detect the drop from the status code.
- **`auth.uid() is null` is a full escape.** Seed, migration and service contexts have no JWT
  and pass untouched. That is what lets the seed write confidences directly.

The member's own path, `set_my_confidence`, passes because `auth_is_self(new.member_id)` is
true. It is SECURITY DEFINER, but the guard does not read `current_user`, and `auth.uid()`
resolves from the JWT claims inside a definer function as usual.

## Member seat invariants

### The last director

The invariant used to live in the app repository as a read-then-write with no lock (archive
023), so a direct write could orphan a tenant and two concurrent demotions could both observe a
survivor and both pass. `FOR UPDATE` in the "is there another director" subquery is the fix, and
it is the only reason that subquery is not a plain EXISTS. The BEFORE ROW trigger runs after the
target tuple is locked, so a concurrent demotion of the other director blocks on that lock, then
re-reads the row and sees it is no longer a director.

Archive 028 widened the condition: unbinding `user_id` or moving the seat to another ensemble
also counts as losing the role, and the surviving director must have `user_id is not null`. An
unbound seat is not somebody who can sign in, so counting it as a survivor would leave the
tenant locked out.

**Trap: this guard blocks account deletion.** `app_user.id` cascades from `auth.users`, and
`member.user_id` is `ON DELETE SET NULL` against `app_user`. Deleting an auth user therefore
issues an UPDATE against every seat that account holds, `new.user_id is null` satisfies the
condition, and if any of those seats is its ensemble's sole active director the entire auth-user
delete aborts with `an ensemble must keep at least one active director`. Nothing in the chain
mentions accounts. Hand off the directorship first.

### Binding consent

`member_write` has one predicate, director-of-this-ensemble, and `authenticated` holds INSERT as
well as UPDATE. Without `guard_member_binding` a director could write any `app_user.id` they can
see onto a seat, making that account an active member of a tenant it never joined. Moving a
claimed seat's `ensemble_id` reaches the same outcome without touching `user_id`, so both
columns are guarded.

The `current_user not in ('authenticated', 'anon')` branch exempts the SECURITY DEFINER
functions that legitimately bind a seat. Inside a definer function `current_user` is the owner,
and every one of them is owned by `postgres`. Two functions bind `member.user_id` today:
`accept_invitation` and `create_ensemble_seeded`. Archive 060's comment named
`claim_membership`, `create_ensemble` and `create_ensemble_seeded`; the first two were dropped
later. The baseline states the rule rather than the list, because the list rots.

The `auth.uid()` escape is the second layer, so the guard does not rest on the `current_user`
behaviour alone: a Data API caller may only ever write their own account onto a seat. The one
thing that permits is a director self-binding to a second seat in their own ensemble, and
`member_ensemble_id_user_id_key` already refuses that.

### Trigger name ordering is load-bearing

BEFORE triggers fire in alphabetical order. `member_last_director_guard` sorts before
`member_seat_binding_guard`, so when a seat is both the sole directorship and being unbound, the
last-director rule answers with the more specific error. Rename either trigger to something that
sorts differently and the reported error changes with no other visible edit.
`member_set_updated_at` sorts last, which is what you want.

`member_seat_binding_guard` is declared `update of user_id, ensemble_id`, so it fires only when
one of those columns appears in the SET list. An ordinary roster edit pays nothing.

## The auth.users mirror

`handle_new_user` and `handle_user_email_change` are the only SECURITY DEFINER functions in this
file. Both write `public.app_user`, whose RLS is self-only, from a trigger on a GoTrue table,
and both address the row by the auth user's own id. Every guard is INVOKER because a guard's job
is to see the caller.

The email mirror exists because `app_user.email` is a convenience copy and `auth.users` is
canonical. `handle_new_user` populates it on insert, and a member changing their address through
`updateUser({email})` writes `auth.users` long afterwards. Archive 058 records the timing
argument: under `double_confirm_changes` GoTrue writes the new address only once the change is
confirmed on both the old and the new address, so the trigger fires on the settled value and no
pending state leaks into the mirror. The `when (new.email is distinct from old.email)` clause
keeps unrelated `auth.users` updates, last sign-in and metadata, from touching `app_user`.

## updated_at is only mostly maintained

The DO loop attaches `moddatetime` to an explicit table list rather than deriving it from the
catalog, so adding a table is a deliberate act and the list is the one place to look. The cost
of that choice is currently unpaid but real.

Twenty base tables carry an `updated_at` column. Seventeen have the trigger. `attendance`,
`prep_target` and `rehearsal_item` do not, and no RPC writes the column on them either, so their
`updated_at` sits at the insert default forever. It is invisible today only because all three
are written exclusively by delete-then-insert (`save_attendance`, `save_prep_targets` and
`save_rehearsal_agenda` each delete the whole scope, then insert). The first partial UPDATE
against any of them, editing a rehearsal item note in place for instance, produces a row whose
`updated_at` is a lie. Add the trigger in the same change as the first partial update, not after.

## Things that look like omissions and are not

**No execute-privilege pair.** Every RPC in the schema carries
`revoke all ... from public; grant execute ... to authenticated`. None of the nine functions in
this file does; their `proacl` is null, which means the default EXECUTE to PUBLIC. That is
harmless here because a trigger function cannot be called directly. Verified against the live
database:

```
=> select public.guard_last_director();
ERROR:  trigger functions can only be called as triggers
```

Note that three helper functions outside this file (`auth_is_self`, `auth_member_tier`,
`gen_public_id`) also lack the pair, so the absence is not unique to trigger functions.

**Explicit `security invoker`.** Archive 036 declared `guard_event_kind_immutable` with no
`security` clause, relying on the default. The baseline states it on every function so the trust
boundary reads the same everywhere. The live catalog agrees: `prosecdef` is false on all seven
guards.

**What this file actually depends on.** At apply time, only the tables and the `moddatetime`
extension from 001. PL/pgSQL bodies are syntax-checked at CREATE but their table and function
references are not resolved, so the call to `public.auth_is_self` from 002 and the GUC contract
with 005 are runtime dependencies, not apply-time ones. Reordering the files would fail no
migration and break at the first test that exercises a guard. The header's ordering claim is
correct about the requirement and worth keeping; do not expect `supabase db reset` to enforce
it.
