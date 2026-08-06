# 005 rpc_director: the curated director writes

Covers `supabase/migrations/20250101000005_rpc_director.sql`, twenty functions the director's
routes call instead of writing tables directly. The SQL says what each one does. This records why
they exist at all, what they cost, and the places where the obvious edit breaks something.

Full text of the originals these replaced lives in `supabase/migrations/_archive/`, referenced by
filename where a reader would want it.

---

## Why these are functions and not statements

Every one of these writes was once a sequence of PostgREST requests. Each request autocommitted,
so a failure part way through committed the prefix and left real corruption behind. The archive
records the specific outcomes, not hypotheticals:

- A member row created with no section memberships.
- A ghost event with no setlist, a half-rewritten program, dangling tag rules, a reorder left
  half-renumbered.
- `set_pins` deleting every `setlist_item`, then failing the re-insert on an FK violation from a
  pinned song that had since been deleted, wiping every note, segue, and pin.
- `create_song` committing the parent song before its parts, stranding an active song with no
  parts. The feasibility gate then reads a partless song as trivially coverable.
- `updateSong` claiming the song row, so advancing its version, and then losing the tag and part
  writes. A live probe left the title changed, the version bumped, and every part deleted.

Sources: `_archive/20250101000016_save_song.sql`,
`_archive/20250101000024_transactional_writes.sql`,
`_archive/20250101000027_transactional_aggregate_writes.sql`.

### The fix was kept narrow on purpose

Only the multi-statement write moved into SQL. Pre-checks that need to return a typed result to
the caller, last-director and not-found among them, stayed in the adapter. That keeps the
boundary the repo states elsewhere: SQL reduces, TypeScript decides. Do not migrate a policy
decision into one of these functions because it would be convenient to have it in the same
transaction.

---

## SECURITY INVOKER is the design

All twenty are `security invoker`, verified against the live catalog. That is what makes a
curated multi-statement RPC safe to grant to `authenticated`: RLS still scopes every touched row
to the caller's ensemble and tier, so folding several statements into one function buys atomicity
without widening anyone's reach.

The cost is specific and worth stating. Under INVOKER, an UPDATE that RLS filters out touches zero
rows and returns success rather than raising. Silence looks like a write. Exactly two functions
carry an explicit `auth_member_tier` check on top of RLS for that reason: `perform_setlist`, which
returns `false`, and `mark_songs_rehearsed`, which raises. Every other RPC in the file relies on
RLS alone, and that is deliberate rather than an oversight.

If you add an RPC whose only effect is an UPDATE against a tier-restricted table, decide
explicitly whether a non-director calling it should get a lie or an error.

---

## Optimistic concurrency

Four functions take an expected version: `save_song`, `set_song_casting`, `set_availability`,
`set_breaks`. The mechanism, from
`_archive/20250101000009_concurrency_rpcs.sql`, is one shape used four times.

Each claims its parent row by bumping `updated_at` only if it still equals the caller's token,
then rewrites the child collection in the same transaction. The parent row lock taken by the
guarded UPDATE is held across the delete and the insert. A concurrent same-token writer blocks on
that lock, then sees the bumped version, matches zero rows, and gets a conflict. Exactly one
writer wins. A failed rewrite rolls back the claim, so the token never advances without the data.

The token is the row's own `updated_at`, not a separate version column. `moddatetime` maintains it
(confirmed on `song`, `event` and `setlist` in the live catalog), and the `returning updated_at`
value is the fresh token handed back.

### Why set_breaks reports a bare conflict

`set_availability` and `save_song` distinguish `conflict` from `not_found` after a zero-row claim.
`set_breaks` returns only `conflict`. The difference is not sloppiness: `set_breaks` takes a
`for update` lock and reads status before it attempts the claim, so by the time the claim runs the
row provably exists. A zero-row result can then only be a version mismatch.

Running the draft check under that lock also means a non-draft is rejected with no side effect at
all, before `updated_at` moves.

### Trap: the returned token can be stale before the response is written

`set_breaks` returns the version its own UPDATE produced. The breaks route then runs
`resyncMemberSnapshot`, which on a shared draft writes `draft_order` and bumps the setlist's
`updated_at` past that value. The route therefore re-reads `getSetlistMeta().version` and hands
that back instead. Without the re-read, the editor re-seeds a stale token and every later break
edit 409s forever.

This is pinned by an integration assertion in `apps/web/test/integration/setlists.itest.ts`. Any
new route that both calls a versioned RPC and then performs a second write against the same parent
row needs the same re-read.

---

## The two GUC handshakes with the guards in 003

Two functions here cannot work without a cooperating trigger in
`20250101000003_guards.sql`, and the cooperation runs through a transaction-local GUC. This is the
least visible coupling in the file. If the guard triggers are absent, the `set_config` calls become
no-ops that fail open in the wrong direction.

### set_song_casting and app.casting_writer

`casting.self_reported_confidence` belongs to the member, never the director. An earlier trigger
guarded UPDATE only, so a director could change a member's stored self-report by deleting and
re-inserting the casting. A live probe did exactly that through the RLS-scoped API
(`_archive/20250101000017_casting_confidence_insert_guard.sql`).

The obvious fix, nulling the column on any non-self INSERT, would have broken `set_song_casting`.
That function rewrites a song's whole casting collection on every director save: it snapshots the
prior rows, deletes, and re-inserts each one carrying the member's preserved value, running as the
director. A blanket INSERT guard would wipe every member's self-report on each save.

So the function vouches for its own re-inserts with
`set_config('app.casting_writer', 'rpc', true)` and `guard_casting_confidence` trusts only that
flag. `is_local = true` means it resets at transaction end, so it never leaks across a pooled
connection. A raw director INSERT is a different transaction, carries no flag, and stays guarded.

### perform_setlist and app.perform_writer

`setlist_immutable_guard` raises on any update to an already-performed setlist row. The first
attempt at the performed snapshot was a second UPDATE issued by the caller after `perform_setlist`
returned, and the guard blocked it. The result recorded in
`_archive/20250101000048_perform_setlist_writes_snapshot.sql`: `performed_snapshot` was never
written, `getPerformedSet` always fell back to live data, and the bug stayed open while the
guard-free mock froze correctly.

The fix folds `p_snapshot` into the same UPDATE that flips status. That UPDATE passes because
`old.status` is not yet `'performed'` and the perform-writer flag vouches for the transition.
Note that `old.status` at that point is whatever non-performed status the set holds, `'draft'` or
`'final'`. Both are legal starting points.

**This is the trap to preserve.** Splitting that UPDATE into two, for any reason, silently reverts
the bug. The snapshot the app builds must come from the same order perform freezes, deduped and
capped, so it aligns with `setlist_item`.

---

## perform_setlist

**Two bounds, two policies.** The order is deduped on first occurrence and then sliced to 512, so
a duplicate cannot bump a song to a stale position and an oversized order cannot freeze a
malformed record. Above 2048 the function raises SQLSTATE 22023 instead. The policy changed
deliberately from truncate to reject: a caller sending more than the bound should learn the order
was refused rather than receive a success for a partially saved set. The route cap
(`MAX_SET_IDS = 512` in `apps/web/lib/limits.ts`) slices rather than rejects, and a direct
PostgREST call bypasses it entirely, which is why the RPC re-does the work.

**The date is derived, not passed.** The performed date is the event's own `event_date`, falling
back to today in the ensemble's timezone resolved through `pg_timezone_names`, defaulting to UTC
when the ensemble's timezone string does not resolve. Before this it was bare `current_date`, so a
set performed near midnight stamped a day off for ensembles outside the server's zone
(`_archive/20250101000011_perform_setlist_tz.sql`). Not the server's clock, and not the caller's.

**A 'final' set can be performed.** The status check rejects only `'performed'`. That is correct:
`'final'` is the normal state a set is performed from, even though the three draft-child RPCs
below refuse it.

---

## prune_member_coverage

Runs when a singer goes non-singing or a seat is deactivated. `save_member` calls it behind
`p_prune`, and `set_member_status` in `20250101000007_rpc_platform.sql` calls it too. It needs its
own EXECUTE grant to `authenticated` despite being an internal helper, because both callers are
INVOKER and reach it as the authenticated caller.

### It is irreversible

The deletes on `casting` and `availability` carry no date predicate. Deactivating a member erases
their entire coverage and RSVP history, not only their future commitments. Nothing offers a soft
form, and nothing in the archive treats this as recoverable. Any UI that presents deactivation as
a toggle is misrepresenting it.

### What the promotion ordering actually ranks

After the deletes, one set-based statement promotes a new primary on each part the departing
member led. The order is confidence first (solid, then shaky, then learning, with a null
confidence ranking as solid), then `created_at`, then `c.id`.

Read the `created_at` term carefully. `set_song_casting` rewrites a song's castings wholesale, and
the re-insert does not carry the old `created_at` forward, so the column records when the director
last saved that song's casting, not when a member was cast to a part. In the common case every
candidate shares one timestamp and `c.id` decides. The term is real but it is rarely the term that
does the work.

The `c.id` tiebreak was added when the per-part loop became one set-based statement
(`_archive/20250101000045_prune_member_coverage_set_based.sql`). The rewrite is otherwise
behaviour-preserving; the tiebreak makes a tie on `(confidence, created_at)` resolve
deterministically instead of arbitrarily. That is a small real behaviour change, and the archive
flags it as worth verifying under the live stack because it drives member-departure coverage
promotion.

The confidence ranking itself is inherited from the adapter's `pruneMemberCoverage` and is not
argued for anywhere.

---

## The draft assertion on set_pins, set_item_field and set_breaks

These three raise `55000` when the setlist is not a draft. The reasoning, from
`_archive/20250101000044_draft_only_setlist_child_writes.sql`, is careful about scope. The routes
already reject a locked set before calling. The `guard_performed_child` triggers already block
writes to a performed set's children. The gap is `'final'`, which has no trigger-level guard, so a
director could call these RPCs directly through PostgREST and edit a set the app considers locked.

No tenant or role boundary is crossed. These are INVOKER and the child write policies are
director-only. This is workflow and record integrity, not isolation. The app path never triggers
it, and integration tests assert all three refuse a final set.

Worth knowing: nothing in `apps/web` or `packages` branches on `55000` or on `22023`. The error
codes are chosen for a reader and for a future handler, not consumed today.

---

## set_item_field

`setItemNote` and `setTransition` each did a read-modify-upsert of the whole `setlist_item` row, so
two concurrent edits to different fields of the same song, one note and one segue, clobbered each
other (`_archive/20250101000029_item_field_atomic.sql`). The RPC takes a `for update` lock on the
row and writes only the named field.

It also drops the row when nothing anchors it any more: no pin, not excluded, no note, no segue.
Rows here are a sparse overlay on the draft, not a full membership list.

The `v_position` filler of 0 exists because the CHECK requires an excluded row to have a null pin
and null position, and a non-excluded row to have a position. Draft rows are not yet sequenced, so
they all sit at 0. There is no unique constraint on `(setlist_id, position)`, verified in the live
catalog, so the collision is harmless. Uniqueness is on `(setlist_id, song_id)`, which is what
every `on conflict` clause in the file targets. Adding a positional unique constraint would break
`set_pins`, `set_item_field`, `clone_setlist` and `create_setlist_from_program` at once.

---

## Trap: set_pins cannot be called twice in one transaction

`set_pins` snapshots existing notes and segues into a temp table, `_pin_meta`, declared
`on commit drop`. Under PostgREST each RPC call is its own transaction, so the table is created
and dropped cleanly every time.

Call it twice inside one transaction and the second `create temp table` fails with
`relation "_pin_meta" already exists`. Confirmed directly against the local database. Any future
wrapper that batches setlist edits into a single transaction, or any function that calls `set_pins`
more than once, has to change the snapshot to a CTE or a named temp per call first.

---

## Part order is display only

`part.sort_order` exists because directors enter parts in whatever order comes to mind and a part
split is often discovered after the fact. The drafter is order-agnostic by design: it sorts parts
by id, and the hydration functions carry no ORDER BY on parts. Grepping `packages/core/src` finds
no reference to `sort_order` at all. No gate depends on this column.

There is deliberately no reorder RPC. The client already sends parts in visual order, so
`create_song` and `save_song` stamp `sort_order` from the array index via `with ordinality`, and a
reorder is just "reorder the array and re-save."

`save_song`'s part reconciliation mirrors the adapter's `writeParts`: keep ids that still name a
part of this song so their castings survive, drop the rest and let their castings cascade via FK,
update the kept in place, insert the new. A duplicate id updates once and then becomes an insert.

Unknown tag names are dropped rather than rejected in both `create_song` and `save_song`, matching
the adapter.

---

## Tag effects, and the lesson about signatures

`save_event` and `save_event_type` both resolve tag names to this ensemble's tag ids and both
apply the same precedence for a tag named in more than one list: exclude, then require, then
prefer. `require` is a set-level mandate enforced in `core`; the database only persists the effect
and lets hydrate surface the list.

Adding `p_require` changed the argument list, and create-or-replace cannot change a signature in
place. The old five-argument overload had to be dropped, because leaving it live means a caller
can bind the stale one (`_archive/20250101000033_require_tag_effect.sql`). Later additions were
shaped to avoid that: `max_duration_seconds` and `kind` both ride inside `p_data` rather than
arriving as new arguments, so both were plain create-or-replace.

Prefer a payload field to a new argument on these two functions unless the value genuinely needs
to be typed and constrained at the boundary.

---

## save_event seeds no availability

This reverses an earlier decision and is the strongest product argument in the file
(`_archive/20250101000049_no_seed_availability_on_create.sql`). Creating an event used to insert an
`'in'` RSVP for every active singing member.

A fabricated `'in'` forges a confirmation the member never gave, and the director then cannot tell
"saw the event and confirmed" from "has no idea it exists". Members now start with no availability
row, meaning pending, for gigs and rehearsals alike.

The cost was weighed and accepted. The drafter counts a member as available only on an explicit
`'in'`, or `'tentative'` when `countTentativeAsAvailable` is set
(`packages/core/src/drafter/index.ts`), so it already reflected confirmed reality. A fresh gig with
no RSVPs simply drafts nothing until singers respond, and staffing-free early sketching lives in
the Playground instead.

The gig Main-set setlist seed stays, so a new gig still has a set to fill. A rehearsal gets none
and uses its agenda.

`kind` is fixed at create and intentionally not updated on the edit path. A gig stays a gig. It is
a calendar and list discriminator, not a drafter signal: neither the hydration nor the funnel reads
it. `guard_event_kind_immutable` in 003 backs this up at the table, because a director's write
grant makes the RPC skippable.

---

## The three kind guards point different ways

- `save_rehearsal_agenda`: rehearsal only. A gig's plan is its setlist.
- `save_attendance`: rehearsal only. It shipped without a guard, and one was added after noticing
  an authenticated director could call the RPC directly for a gig and persist rows the UI never
  intends (`_archive/20250101000040_attendance_kind_guard.sql`).
- `save_prep_targets`: gig only, the inverse. A prep target is a commitment to have a song ready
  for a given gig, with the gig's `event_date` as the deadline. A rehearsal is the preparation, so
  it carries no targets of its own.

If you add a fourth event-child write, decide which way its guard points before writing the body.
Two of these three already had to be corrected after the fact.

---

## Caller-frozen dates

`mark_songs_rehearsed` takes `p_date` rather than calling `now()`. The caller freezes the rehearsal
date, so recording a rehearsal days later stamps the day it happened rather than the day it was
entered.

The stamp is `greatest(last_rehearsed, p_date)`, which is monotonic and idempotent: re-recording
never moves a date backward and running it twice is a no-op. Postgres's `greatest` ignores nulls,
so a song with no prior date takes `p_date` cleanly. Verified directly. The manual date field on
the song form remains a hand override, and this is the same stamp shape `perform_setlist` uses for
`last_performed`.

`perform_setlist` derives its date rather than accepting one, but the instinct is the same: prefer
the event's own date over any clock.

---

## save_attendance has no version token

Attendance is not co-edited the way RSVP is, and sharing `event.updated_at` as the token would
false-conflict against RSVP edits on the same event. So the write is unguarded by version and
simply replaces the set, deduped by member with the last occurrence winning.

`availability` answers "who plans to come"; `attendance` answers "who showed". They are separate
tables precisely so an RSVP is never overwritten with an attendance value.

---

## reorder_vocab and the dynamic SQL

The only function in the file that builds SQL at runtime. `p_table` is whitelisted against a fixed
three-element list (`voice_part`, `event_type`, `tag`) before it reaches `format()`, so `%I`
quoting is safe and the argument cannot be turned into arbitrary SQL. The dynamic statement is the
price of one function covering three structurally identical tables.

The semantics are not obvious from the CTE, so: supplied ids lead, deduped on first occurrence and
filtered to rows that exist; omitted rows follow in their current `sort_order`, pushed behind by
the `1000000 +` offset; the whole set is renumbered 0..n-1 in one UPDATE. One statement means there
is never a half-renumbered intermediate state and no unique-collision window. A per-row UPDATE loop
left exactly that on any failure.
