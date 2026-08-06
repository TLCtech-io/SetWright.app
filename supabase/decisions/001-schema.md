# 001 schema: tables, constraints, indexes

Why the data model is shaped the way it is. The SQL in
`supabase/migrations/20250101000001_schema.sql` says what the shape is: 27 tables, 49 explicit
indexes, and the constraints that hold them together. This file covers the parts a reader cannot
reconstruct from the object.

The 64 migrations that arrived at this shape are kept in `supabase/migrations/_archive/`. Where a
decision came out of a specific incident, the archive file holding the original fix is named.

## Tenancy is enforced twice, on purpose

Every foreign key between two tenant-scoped tables is composite and carries `ensemble_id` as its
first column, targeting a `unique (ensemble_id, id)` on the parent. The database refuses a
cross-tenant reference on its own, with no reference to RLS.

The price is real: a redundant unique constraint, and the index behind it, on almost every table,
plus wordier FK declarations everywhere. It was paid because RLS is one layer and policies get
written wrong. This is the layer that still holds when one does.

24 base tables carry `ensemble_id`. 23 of them declare a direct FK to `ensemble`. `member_invite`
is the exception: it reaches the tenant only through its composite FK to `member`, which is also
what deletes it when the seat goes.

## On delete

Child rows and link tables cascade from their owning parent. Four references depart from that,
each for a stated reason.

**References to `ensemble` are NO ACTION.** All 23 of them. A tenant is retired by setting
`ensemble.status = 'archived'`, never deleted, and the FK shape is what enforces that: a tenant
delete blocks instead of cascading through the whole dataset. There is no delete-based teardown
path in the codebase. The one teardown that exists, `supabase/test-reset.sql`, truncates each
table individually with CASCADE and does not depend on these FKs.

**`part -> voice_part` is NO ACTION.** A voice part cannot be deleted while a chart still calls
for it. Deleting a section out from under live parts would leave the drafter with lines it cannot
match anyone to.

**Optional config references use the column-list form of SET NULL.** `event -> event_type` and
`event_type -> padding_profile` are composite FKs whose reference is optional. A bare `set null`
on a multi-column FK nulls every column in it, including `ensemble_id`, which is `not null`, so
the parent delete fails outright. `on delete set null (event_type_id)` clears only the optional
column.

That syntax is PostgreSQL 15 and later. The original schema header claimed PostgreSQL 13+, and
that was never true once these two FKs landed. This schema needs 15. The local stack runs 17.

**`setlist -> program` is RESTRICT.** The one reference in the schema that restricts rather than
blocking by no-action or cascading. A program is a reusable running-order template, and a setlist
built from one keeps pointing at it. Deleting a program that any setlist was created from is
refused, so the provenance of an existing set cannot be removed out from under it. Detach or
delete the setlists first.

## History must not depend on the present

`performance_soloist` is the deliberate exception to the FK discipline, and the exception came
from an incident. The table originally bound `song_id`, `part_id` and `member_id` by composite FK
with `on delete cascade`, including one constraint that bound part to song so a soloist could not
be recorded against a part belonging to a different song.

The consequence, confirmed by a live probe: a routine chart edit deletes and reinserts parts, so
editing a chart silently erased every historical solo appearance on that song. Removing a member
did the same to that member's history. Archive 014 denormalised `song_title`, `part_label` and
`member_display_name` onto the row and dropped the three FKs. Only two FKs remain, to `setlist`
and to `ensemble`. The bare `song_id` / `part_id` / `member_id` columns and their indexes survive
as unenforced references, useful for grouping and useless as integrity.

The same principle produced three later columns on `setlist`.

- `performed_date` (archive 006). Reads used to derive the date of a performance from
  `event.event_date`, so correcting an event's date rewrote history.
- `performed_snapshot` (archive 046). A performed set was billed as immutable but only its order,
  soloists and date were frozen. The sheet re-read live song and event rows, so editing a song's
  duration after a gig retroactively changed that gig's total. Null for sets performed before the
  column existed; those fall back to live reads, and there was no backfill.
- `setlist_performed_has_date` (archive 021). A director could PATCH a draft straight to
  `status = 'performed'`, producing a performed set with no date and no frozen order. The check is
  defence in depth behind the guard trigger in file 3 that enforces the same rule.

## The three setlist order columns are not interchangeable

They look like variations on one idea. They are not, and using one where another belongs produces
a wrong sheet rather than an error.

- `arranged_order` is what the director set by hand. Advisory: the drafter still decides
  membership, this only overrides sequence, and a redraft clears it back to null. It carries no
  constraint because `loadSetlist` reconciles a stale or partial list defensively.
- `draft_order`, gated by `share_draft`, is the snapshot a member sees for a live draft. It exists
  so a member never runs the drafter, which would expose the whole event pool: every RSVP and the
  full casting map. Both columns ride the `setlist` row, so a member reads only `setlist` for a
  draft, never `setlist_item` or `setlist_break`.
- `published_order`, paired with `published_at`, is the order members read for a published set.

The name `published_order` oversells it. The order is not frozen at publish. `syncPublishedOrder`
rewrites it, and `draft_order` with it, on every order-changing edit, guarded so it touches only a
set that is currently published and not yet performed. Freezing happens at perform time, into
`performed_snapshot`, not at publish.

Archive 054 added `arranged_order` because 041's stated intent, freeze the current draft order,
was not achievable when it was written. Before `arranged_order` there was no persisted hand order
at all, so publish and share froze the re-drafted canonical order rather than what the director
had actually arranged.

## The updated_at version token

`updated_at` doubles as an optimistic concurrency token. A read hands the client the row's
`updated_at` as `version`; the write sends it back as the expected value; the write claims the row
with `where id = ... and updated_at = p_expected` and returns the new timestamp as the next token.
Zero rows claimed means either a lost race or a missing row, and each site distinguishes the two.

Reusing `updated_at` instead of adding a version column costs nothing extra to maintain: the
`moddatetime` triggers in file 3 already keep it current on every table that participates.

**Four tables participate.** Three through RPCs in file 5:

| Token | Guards | Function |
| --- | --- | --- |
| `song.updated_at` | the song row, its tags, its parts | `save_song` |
| `song.updated_at` | the song's whole casting collection | `set_song_casting` |
| `event.updated_at` | the event's whole availability collection | `set_availability` |
| `setlist.updated_at` | the set's breaks | `set_breaks` |

The fourth is `ensemble.updated_at`, claimed in the app layer rather than in SQL:
`updateEnsembleSettings` in `apps/web/lib/supabase/repository.ts` adds
`.eq("updated_at", expectedVersion)` to a plain UPDATE. That path has an extra wrinkle worth
knowing: a stale token and a non-director both match zero rows, so it re-reads the row to tell a
conflict from an RLS refusal.

**A parent's token guards its children.** Casting rows, availability rows and breaks have no token
of their own. The guarded UPDATE on the parent takes the parent row lock, and the delete-and-insert
that rewrites the collection runs under it in the same transaction. A concurrent writer holding the
same token blocks, then sees the bumped version and gets a clean conflict instead of a half-applied
rewrite.

The cost is coupling. Editing a song's parts and editing its casting move the same token, so a save
on either side conflicts an editor open on the other. That was accepted; the two screens are
editing the same chart.

**Attendance deliberately opts out.** `save_attendance` takes no token. Attendance is not co-edited
the way RSVP is, and the only parent token available is `event.updated_at`, which would
false-conflict against every RSVP edit. Sharing it would have made the guard noisier than the
problem.

**The token is transaction time, not statement time.** `moddatetime` writes the transaction start
timestamp, verified by probe: two UPDATEs in one transaction produce the same `updated_at`, and a
row inserted then updated in one transaction never moves off its insert value. Each RPC call is its
own transaction, so the pattern works. What it cannot do is distinguish two writes batched into one
transaction. Do not build a multi-write endpoint that expects the token to advance between steps.

## Three tables carry updated_at that nothing maintains

`attendance`, `prep_target` and `rehearsal_item` have an `updated_at` column and no `moddatetime`
trigger. 17 of the 20 base tables carrying the column have one; these three do not, and no RPC
writes the column by hand. Their `updated_at` permanently equals `created_at`.

They arrived after the loop in archive 001 that attached the triggers and were never added to it.
The staleness is invisible today because all three are written only by full replace:
`save_attendance`, `save_prep_targets` and `save_rehearsal_agenda` each delete every row for the
event and insert fresh ones, so the insert default is always correct.

It becomes a live bug at the first partial UPDATE. Editing a rehearsal item's note in place, or
flipping one attendance row, would leave a timestamp claiming the row had not changed since
creation. This is a known gap, tracked separately. Fixing it means adding the three triggers, not
working around the column.

`member_invite` has no `updated_at` at all, which is correct: `invited_at`, `first_invited_at` and
`declined_at` carry its lifecycle.

## Vocabularies

Fixed vocabularies are `text` plus a check, not enums. Changing a check is a migration; changing an
enum is a migration plus a type rewrite, and the vocabularies here have already moved more than
once. Vocabularies that vary per ensemble get their own tables: `voice_part`, `tag`, `event_type`.

`ensemble.confidence_visibility` deliberately omits the planned `'member_choice'` value from its
check. Shipping the per-member toggle without the accompanying schema change should fail loudly at
the write rather than store a value nothing understands.

`voice_part_label_ci` and `tag_name_ci` are unique on `(ensemble_id, lower(...))`. The app treats
"Bass" and "bass" as one section and "Gospel" and "gospel" as one tag. A case-sensitive unique
would have let a duplicate straight through the editor's own duplicate guard.

Four partial unique indexes make singleton rules the database's problem rather than the app's:
`casting_one_lead_per_part`, `member_one_primary_section`, `program_one_open`, `program_one_close`.
The app already treated all four as at-most-one.

## Columns that look like signals and are not

Several columns read like drafter inputs. Reading them that way leads to wrong conclusions about
what the funnel does.

- `tag.category`. Only `mood`, `groove` and `genre` have behaviour, and only one: the sequencer
  diversifies adjacency on them. `occasion` and `content` are labels with no effect anywhere.
  Categorising a tag as `content` does not gate anything. Content gating is `song.is_explicit`
  checked against `event.allows_explicit` in `packages/core/src/drafter/context.ts`, and has
  nothing to do with this column.
- `event_type_tag`. A client-side prefill, not a standing rule. Nothing server-side reads it when
  an event is saved or drafted: `save_event` builds `event_tag` from its own arguments alone. The
  event form copies these tags onto a new event on the first type pick while the form is untouched,
  and on demand in the edit form via Apply. Every copied tag is editable afterwards. An import or a
  seed applies none of them.
- `part.sort_order`. Display only. The drafter is order-agnostic and the hydration carries no
  `order by`, so no gate reads it. There is no reorder RPC either: the client sends parts in visual
  order and both write paths stamp the array index, so a reorder is reorder-the-array-and-re-save.
- `event.kind`. A calendar discriminator so a rehearsal can reuse the whole event, availability and
  RSVP machinery. The hydration and the funnel never read it. It defaults to `'gig'`, so every
  existing event and read path stays gig-only unless it opts in. It is set at create and not edited
  afterwards, though nothing in the schema enforces that.

`event.max_duration_seconds` is the opposite case: a real ceiling, distinct from the soft
`target_duration_seconds`. The two-tier behaviour lives in core. The check here only guarantees the
cap is positive and not tighter than the target.

The accompaniment trio (`song.uses_accompaniment`, `event.allows_accompaniment`,
`event_type.default_allows_accompaniment`) mirrors the explicit trio with one deliberate asymmetry.
The event and event-type flags default **true**: accompaniment is permitted unless a director turns
it off. The song-side flag defaults false, a cappella, matching `is_explicit`.

## Availability, attendance and prep targets

`availability` is intent and `attendance` is fact, and they are separate tables so that recording
who showed can never overwrite who said they would come. Both use the same convention: a missing
row means no answer, which is distinct from `'out'` or from `present = false`.

`prep_target` models a commitment that nothing else could express: have this song ready for that
gig. `setlist` is the performed output, and an `event_tag` with effect `prefer` only steers a draft
softly. Neither says "we are learning X for show Y". The gig's `event_date` becomes the deadline
that drives the behind-schedule view. It is unordered and gigs only, because a rehearsal is the
preparation rather than a thing to prepare for.

## Invite state lives off member

Archive 019 and 022 put `invite_email`, `invited_at` and `invite_token_hash` directly on `member`.
`member_read` lets any active member SELECT the whole row, and RLS is row-level, so app-layer
masking did not stop a raw PostgREST query from reading a peer's pending invite address and token
hash. Archive 047 moved the three columns into the director-only `member_invite` side table and
dropped them from `member`, which makes RLS the enforcement rather than the UI.

`invite_token_hash` is SHA-256 of a token that exists only in the invited inbox. A confirmed email
address is not proof of inbox control: public signup auto-confirms locally and on any misconfigured
hosted instance, so an attacker could pre-register a victim's address and bind a seat invited under
it. The roster only ever sees the hash.

Two later columns each close an unbounded window.

- `first_invited_at` (archive 063). `refresh_pending_invite` sets `invited_at = now()` and is
  reachable from an unauthenticated route rate-limited at three an hour per address, so roughly one
  request a fortnight from anyone who knew the address kept a seat bindable forever. This column is
  the anchor that path cannot move: set once at insert, never written again. 30 days is the ceiling
  on self-serve renewal, a little over twice the link lifetime.
- `declined_at` (archive 064). A refusal keeps the row so the roster can show the director what
  happened instead of an invite that looks like it is still waiting.

**Trap: `member_invite_one_per_email` has no partial predicate.** The table holds pending rows and
declined rows alike, and every consumer filters `declined_at is null`, but the unique index does
not. A declined row therefore keeps occupying the `(ensemble_id, lower(invite_email))` slot. The
app pre-checks for a colliding invite on another seat and returns a friendly duplicate; the index
is the backstop, and a 23505 from it is mapped to the same result. Deleting the seat deletes the
row and frees the slot. Adding a `where declined_at is null` predicate would change behaviour, not
just tidy the index, so it is a decision rather than a cleanup.

## Two flags on app_user that no route may write

`is_platform_admin` authorizes the `/admin` surface and nothing else. No RLS policy reads it, so a
platform admin still cannot see another ensemble's rows. It is set out of band by direct SQL,
because an endpoint that grants admin is a privilege-escalation target by construction.

Setting it out of band is not sufficient on its own. File 2 pins `authenticated`'s UPDATE privilege
to `(email, display_name)`, because column privileges are checked independently of RLS: a blanket
table UPDATE plus a self-row policy would have let anyone PATCH the flag onto their own row.

`founding_credits` gates ensemble creation. `create_ensemble_seeded` is directly callable through
PostgREST, so closing the UI was never enough and the gate had to live in SQL. A plain member has
zero credits and is refused.

## public_id

`public_id` is the one identifier the app mints and the only one that appears in a URL. The uuid
stays the join key everywhere below the routing layer. It is base64url of 16 random bytes with
padding stripped, exactly 22 characters, 122 bits of entropy from `gen_random_uuid()`.

It is an identifier, not a secret. RLS still draws tenancy, and possession of a token grants
nothing. Six tables carry one: `ensemble`, `song`, `member`, `setlist`, `event`, `program`.

**`gen_public_id()` is volatile on purpose**, verified in the catalog, and the property is
load-bearing. `add column ... default gen_public_id()` evaluates a volatile default once per
existing row, which is what gave every backfilled row a distinct token. A stable or immutable
default would be evaluated once and reused, and the unique indexes would have rejected the
backfill. `volatile` is written out even though it is the SQL default, because nothing else in the
declaration reveals that the backfill depended on it.

The function lives in this file, which is otherwise structure only, because six tables take it as a
column DEFAULT and a default must resolve at create-table time. In the archive series the ordering
was the other way round: the tables existed first and archive 050 added the function immediately
before the `add column`s that used it. `create extension if not exists moddatetime` is here for a
similar reason, though nothing in this file uses it. The extension lands in `public`, which is what
makes `public.moddatetime` resolve in file 3's trigger definitions.

## Traps

**Auto-generated constraint names depend on declaration order.** Postgres names an unnamed check
after the single column it references. A check touching two or more columns falls back to
`<table>_check`, then `_check1`, `_check2`, numbered in declaration order. That is where
`song_check` through `song_check3`, `part_check` and `part_check1`, `event_check`, `member_check`,
`voice_part_check` and `setlist_item_check` come from, all present in the live catalog. Reordering
the check list inside a `create table` renames constraints. Nothing references them by name today,
but a future `drop constraint` migration would, and archive 033 already had to hardcode
`event_tag_effect_check` on the strength of this rule.

**Primary keys are v4, so id order is not creation order.** The original header stated a preference
for app-layer uuid v7 for index locality. It was never built and every live default is
`gen_random_uuid()`. Anything ordering by `id` and expecting insertion sequence is wrong. Use
`created_at`.

**`invite_rate_event` is the one non-uuid primary key**, `bigint generated always as identity`. It
is an append-only ledger read by range, not an entity anything references. Its two indexes serve
the two access patterns: `(subject, kind, created_at)` for the limit check, `(created_at)` for the
opportunistic global GC that deletes on age alone.

**`part` has a leftover unique.** `unique (ensemble_id, song_id, id)` backs nothing. The only FK
targeting `part` is `casting_ensemble_id_part_id_fkey`, served by `unique (ensemble_id, id)`. The
three-column unique existed to be the target of `performance_soloist`'s part-to-song bind, which
archive 014 dropped. Its only remaining effect is an extra index, which the catalog shows has never
been scanned. It stayed because dropping it is a change with no benefit, not because it does
anything.

**The index set was never tuned.** The 49 explicit indexes are the foreign-key set, the tenant key
on link tables, the singleton and case-insensitive uniques, and the six `public_id` lookups.
Constraint-backed indexes are not repeated. No index here came from measuring a slow query, so
treat the set as a starting point rather than evidence that a query path is covered.
