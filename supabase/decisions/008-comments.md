# 008 Catalog comments

Covers `supabase/migrations/20250101000008_comments.sql`: 23 `COMMENT ON` statements and no DDL.

Archived originals: the object headers these comments replace are spread across
`supabase/migrations/_archive/`. The ones a reader will want in full are
`_archive/20250101000062_casting_visible_barrier.sql` for the barrier measurement,
`_archive/20250101000059_hydrate_search_path_pins.sql` for the pins, and
`_archive/20250101000038_rehearsal_record.sql` for the original attendance policies.

## Why the documentation rides in the catalog

The reader who is about to make the mistake is usually not in the migration set. They are in the
Supabase dashboard acting on a database advisor lint, or in psql inspecting a view, or grepping a
function body. A header comment in a migration from eighteen months ago never reaches them. A
comment attached to the object does.

The second reason is durability. A catalog comment survives `create or replace function`, verified
against the local database: replace a function and its `obj_description` is still there while its
`proconfig` is gone. That is the exact asymmetry the pin comments exist to exploit. The property
being protected is the thing a redeclaration silently drops; the warning about it is the thing a
redeclaration keeps.

## Why a file with no DDL

Every statement here is a comment on an object created in 001 through 007, so the file applies last
and depends on all of them. Nothing in it depends on anything else in it, so the order inside is
for readers only.

The payoff is the apply. Catalog comments on the hosted stack are a manual step, and batching them
into one file means one apply instead of eight, against a diff that cannot change behaviour. It
also removes an ordering question: a comments-only file at the end can reference any object without
anyone reasoning about where it sits.

## What earns a comment

Something a reader looking at the object cannot see, where being wrong about it fails silently.
That bar is doing real work, and the corollary matters as much as the rule: ordinary behaviour
belongs in the file that creates the object, not here and not in this record.

`member_invite.declined_at` shows the division. Its comment says only what the column means. The
consequence that matters, that a declined row keeps its slot in
`member_invite_one_per_email (ensemble_id, lower(invite_email))` until the seat is removed, so a
re-invite to that address succeeds while the invitee never sees it, is documented at the definition
site in 001 and at every consumer in 007. Repeating it here would create two places to keep true.

Three comments confirm a design rather than warn about one: peer visibility of RSVPs, of
attendance, and of who covers which part. All three are intended and shipped. A security review
read the first as a leak precisely because nothing at the object said otherwise, which is what
turned "this is fine" into something worth writing down.

## The drafting constraint on the comment text

`scripts/check-search-path-pins.mjs` builds its model of which functions are live and which are
pinned by regexing the raw text of every `.sql` file in `supabase/migrations/`. This file is one of
them. The three patterns it matches are:

```
/create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_]+\.)?([a-z_]+)\s*\(/gi
/alter\s+function\s+(?:[a-z_]+\.)?([a-z_]+)\s*\([^)]*\)\s*set\s+search_path/gi
/drop\s+function\s+(?:if\s+exists\s+)?(?:[a-z_]+\.)?([a-z_]+)/gi
```

None of them knows it is inside a string literal. A comment that spelled out a declaration would
register a new live function with no pin and fail CI. Worse, the two quiet ones: a comment
containing a drop phrase would delete a real function from the model, and one containing an alter
phrase would mark a genuinely unpinned function as pinned. Both leave CI green and the check
useless.

So the file names functions bare throughout and never writes those phrases. The hydrate comments
say "search path pin" with a space and "the set clause" separately, so that `/set\s+search_path/`
never matches. Grepping the file for any of the three patterns returns nothing today. That is a
property to preserve, not a coincidence.

One more thing sharpens the trap. The pins check runs only in CI (`.github/workflows/ci.yml:84`).
`npm run verify` is `typecheck && email:check && build && test` and never calls it. So a comment
string that corrupts the model is invisible to the offline gate entirely.

## What the offline gate does and does not catch

The schema used to claim that `npm run verify` never touches SQL. That is wrong.
`packages/db/test/validate.ts` runs under `npm test` and parse-validates every migration in apply
order with libpg_query, no database needed. Grammar errors do fail offline.

What survives both gates is a pin with the wrong value. The parse harness reads no pin. The CI
check tests only that a pin is present, never what it is. So the conclusion in the
`hydrate_draft_input` comment holds and its stated reason had to be replaced: the failure lands at
runtime as `relation "event" does not exist`, taking the whole drafting surface with it.

That is why the pin comments are the highest-value text in the file. Both hydrate functions pin
`pg_catalog, public, pg_temp`; the other 49 pinned functions in `public` pin `pg_catalog, pg_temp`.
The odd ones out are odd because their bodies name tables unqualified. An author copying the house
pattern from a neighbour gets a syntactically fine function that cannot see a table.

## app_user column privileges

The self-promotion guard is a column privilege, not a policy, and column privileges are checked
independently of RLS. `authenticated` holds table-level UPDATE on every public table except
`app_user` and `invite_rate_event`. On `app_user` its update grant is scoped to `email` and
`display_name`. Without that scoping, the self-update policy would let a user PATCH
`is_platform_admin` onto their own row. `founding_credits` inherited the protection for free when it
was added.

The comment used to say the flag was writable by `service_role` and direct SQL. Only the first half
of that was even close: `service_role` holds TRUNCATE, REFERENCES and TRIGGER on `app_user` and
nothing else, so it cannot write the flag and cannot read the table at all. The writer is a
superuser connection, meaning direct SQL as `postgres`.

The trap is the shape of the failure. Add a new self-editable column, get a permission-denied error
that reproduces in no offline gate, and the one-line fix that clears it is restoring the
table-level update grant. That silently reopens self-promotion. The correct fix is adding the one
column to the grant. Since the flag is the only gate on the `/admin` surface and on the founding
credit granters, that one line is the whole boundary.

Worth keeping separate: the flag authorizes a surface, not data. No policy references it, so a
platform admin still reads no other tenant's rows.

## event_type_tag documents a defect, not a decision

The table comment used to describe these as rules a type "should always enforce". Nothing
server-side applies them. `save_event` resolves `event_tag` from its own `p_exclude`, `p_require`
and `p_prefer` arguments and never reads `event_type_tag`. The only SQL that touches the table is
`save_event_type`, which writes it.

The copy lives in `apps/web/components/EventForm.tsx`. It happens automatically on a new event's
first type pick while the form is untouched, and on demand from the Apply button, which is rendered
in both create and edit mode with no gate on `touched`. Note the second path: it is easy to
describe this as a new-event-only prefill and miss that the edit form can restamp an existing
event at any time.

The gap is real in the other direction. A director who sets a standing exclude rule and then types
the event name before picking the type gets no `event_tag` rows, and the drafter programs the
excluded material with no warning. Imports, seeds, and any create-event RPC written from the old
schema comment inherit the same hole. The honest comment is not the fix; the underlying gap, that
standing per-type rules are enforced by a browser form and by nothing else, is separate work.

## member.is_singing and member.status destroy data

Both columns read as ordinary flags and neither DDL comment hinted otherwise. Writing them runs
`prune_member_coverage`, which deletes every `casting` and every `availability` row for the member
with no event or date predicate. Past and performed events go too. There is no undo, and
reactivating the row restores nothing.

The two failure directions are symmetric and both silent. A director clearing `is_singing` for a
conductor destroys that person's whole casting map and RSVP history. An engineer writing a bulk
roster import straight against the Data API skips the prune instead, and an inactive member keeps
counting toward the coverage gate, corrupting feasibility the other way. Hence the instruction to
go through `save_member` with `p_prune` and `set_member_status`.

The prune was rewritten from a per-part loop into one set-based statement that promotes a new
primary on each orphaned led part. Its ordering is confidence (solid, shaky, learning, with null
treated as solid), then `casting.created_at`, then `casting.id`. The final tiebreak is the casting
row id, not the member id, and it exists so a tie resolves deterministically rather than however
`limit 1` happened to land.

## The four setlist order columns

One table, four jsonb columns, four different freshness contracts, and before this only one of them
carried a comment. Guessing wrong produces a stale running order at a real gig with no error
anywhere, which is why all four are now documented at the object.

`published_order` is the one that misleads. The publish migration said publishing freezes the
current draft order. It does not. The app rewrites `published_order`, and `draft_order` with it, on
every order-changing edit until the set is performed. A new reorder or pin route that skips the
resync serves members the wrong program, silently.

`arranged_order` exists because a draft had no persisted order at all. The drafter re-sequenced from
pins on every load and a free reorder lived only in client state, so publish and share froze the
canonical re-drafted order rather than what the director actually arranged. It is deliberately
advisory and order-only, with no constraint, because `loadSetlist` reconciles a stale or partial
list against the current set.

`performed_snapshot` kept its original text. It documents shape and the null fallback, which is
what a reader of that column needs. The alignment hazard and the single write window belong on
`perform_setlist`, which is where they went.

## casting_visible: owner rights are the design

Supabase's database advisor flags owner-rights views under its `security_definer_view` lint and
recommends `security_invoker = true`. Acting on that advisory here returns zero rows to every
non-director and raises nothing, because members match no select policy on the `casting` base table
at all. The view is their only read path. Its where clause,
`auth_member_tier(c.ensemble_id) is not null`, is the tenant boundary, and its case arms are the
confidence guard.

That advisory reader is in the dashboard, not the migration set, which is the whole argument for
putting the warning in the catalog. `security_invoker` appears nowhere in the repository, so its
absence reads as an oversight rather than a decision unless something says so.

### The barrier, and what it cost

`security_barrier = true` is set on the view and was held back from an earlier security review out
of a specific concern: a barrier view refuses to push non-leakproof caller quals down, and the
drafter's hottest read goes through here. The worry was that the ensemble filter would stop reaching
the base scan, turning the castings CTE into a cross-tenant scan of `casting` with a per-row
security definer call.

It was measured on a seeded stack before shipping, as an authenticated director, against the query
shape the castings CTE uses. Without the barrier the plan filtered on `part_id` with the ensemble
predicate as a post-filter; with it, the plan is an index scan on `idx_casting_ensemble` with the
ensemble predicate as the index condition. `(select ensemble_id from ev)` is uncorrelated, so it
becomes an InitPlan evaluated once to a constant and the qual reduces to a pushdown-safe equality.
The full plans are in `_archive/20250101000062_casting_visible_barrier.sql`. That measurement was
not re-run for this record: the local database holds 12 casting rows, far too few for the planner
to pick an index path at all.

The residual cost is real and worth naming. Quals that genuinely are not pushdown-safe now stay
outside the view. On this view that is the two `in (select ...)` predicates, which already planned
as joins rather than pushdowns.

## Peer visibility is intended, in three places

Availability is the clearest case. Tenant-wide read is the feature, and "see who else is coming" is
shipped member copy. The argument for the comment is the failure mode of narrowing it:
`apps/web/lib/attendanceGroups.ts` buckets a member with no visible row into `pending`, so a
self-only policy would render every peer as no reply and raise nothing.

Attendance is the weaker case and the comment says only what is true. It is tenant-wide, matching
availability. Writes are director-only because attendance is a record the director keeps rather
than a self-report. Only the director rehearsal record reads the table today, so narrowing the
policy would break no screen and no test. That is exactly why the intent needed recording: a
tightening that looks free is the one nobody argues with.

A narrowing of `attendance_read` to self-or-director was proposed and never applied; no such
migration exists in the set. If it is revisited, note the finding from its own review: the director
arm would be redundant. `attendance_write` is `for all`, and a `for all` policy's using clause
applies to select, so a director keeps full read through the write policy regardless.

For casting the precise statement matters. The cover map, who covers which part, is member-readable.
The casting map as a whole is not. Self-reported confidence is withheld unless the caller is that
member, a director, or the ensemble sets `confidence_visibility = 'shared'`; the director assessment
and `learned_at` are director-only. A draft comment that said the casting map is member-readable by
design was corrected for exactly this.

## casting_select_director has a second dependent

The existing prose called this policy load-bearing for filtered director delete and update, whose
failure mode is a harmless no-op. It never named the read that matters more. `set_song_casting`
snapshots the prior castings for a song before replacing them, so self-reported confidence, the
director assessment and `learned_at` survive the replace. That function is security invoker, so the
snapshot reads through this policy. Remove the policy and the snapshot comes back empty, the write
still succeeds, and the learning tracker's history for that song is erased with no error. Silent
destruction, not a no-op.

## setlist_item_read and setlist_break_read stop one disjunct short

`setlist_read` has four disjuncts: director, published, performed, `share_draft`. The two child
policies have three, resolving through an `exists` against the parent for published or performed.
The gap is deliberate and reads as an oversight, which is the trap.

The reason lives in the share-draft migration, which never touches either child table. An editor
tracing `setlist_item_read` lands on the publish migration, which predates `share_draft` entirely
and says nothing about it. The fix then looks like a one-line harmonization. Applying it leaks the
director's private drafting state: the songs they excluded, the open, close and keep pins, and the
per-item staging notes. A shared draft needs none of those rows. It is served entirely from
`setlist.draft_order` on the parent.

## guard_member_binding names the wrong binders

The guard exempts any `current_user` outside `authenticated` and `anon`, so the only code that can
bind `member.user_id` is a security definer function owned by `postgres`. The exemption list written
into the guard's own inline comment names `claim_membership` and `create_ensemble`, both since
dropped, and names neither live binder. An auditor asking what can bind a seat gets two functions
that do not exist.

There are two live binders, not one: `accept_invitation` on the invitee path
(`20250101000007_rpc_platform.sql:494`) and `create_ensemble_seeded` on the founder path (line 305).
Name both. An audit of seat-binding paths that starts from the invitee path alone misses the
founder path entirely.

Both rest on that ownership property and nothing else, so declaring either invoker, or adding an
invoker RPC that joins a seat, starts raising what looks like an RLS error. The dangerous
improvisation that clears it is routing the insert through the service-role client, where the guard
passes and the invitee consent model the guard exists to enforce is gone.

Also worth keeping, from the original header: an RLS `with check` cannot express this rule at all,
because `with check` has no OLD row. That is why it is a trigger.

## perform_setlist: an incident, frozen into a comment

The snapshot write is atomic with the perform because it has to be. The first attempt wrote it as a
second update issued from the adapter after `perform_setlist` returned. The performed-immutability
trigger rejected that update, and the readers' fallback to live data masked the failure completely.
The result was that the bug the snapshot was meant to fix stayed live in production while the
guard-free mock path froze correctly.

Folding `p_snapshot` into the same update that flips the status works because at that statement the
row is still a non-performed set and the transaction-local perform-writer flag vouches for the
write. It is a one-shot window: the value is written once and can never be corrected.

Two consequences are in the comment. Anyone adding a second frozen-at-perform column will reach for
the same second update and hit the same silent failure. And `p_snapshot` must be built with the same
first-occurrence dedupe and 512 cap the function applies to `p_order`, or the frozen program stops
matching the frozen items, with no error and no repair path.

## set_my_availability is definer for a reason nobody recorded

The function is security definer, and its internal resolution of the caller's own active member row
in an active ensemble is the entire authorization. Nothing runs behind it. Two immutable archive
headers still describe it as invoker and name RLS as the authorizer, which makes the internal
resolution look like belt and braces. That is exactly the thing someone simplifies, or relaxes for
an admin-acting-on-behalf path.

Why definer: a member's self-RSVP writes only the `availability` child table, so `event.updated_at`
never moves, because moddatetime is per-table. The director's bulk save guards on
`event.updated_at`, so it does not detect the member's write and overwrites it. The function
advances `event.updated_at` so the director's guarded save conflicts and reloads instead. A member
cannot update the event row under the director-only event policy, hence definer. Restoring it to
invoker to match those stale headers reintroduces the lost update, silently.

## Deliberately not in this file

- The rule that only the highest-numbered declaration of a multiply-declared function is live. It
  goes in `CLAUDE.md` under the cardinal rule. A per-function comment would go stale on the next
  redeclaration, and the file numbers are the part that rots.
- The platform-admin bootstrap, that a hosted instance ships with zero platform admins and the first
  one can only be created by direct SQL against production. That is an operator step for the README,
  not something a psql reader needs.
- Permissive policy composition, the program read policies, the two elevated invite RPCs, and the
  `updated_at` version-token rule. Each is either standard knowledge for anyone qualified to touch
  it, or already documented at the definition site or in `CLAUDE.md`.

One statement in the file documents nothing:
`comment on schema public is 'standard public schema'`. That string is Postgres's own default text.
Read it as part of the object inventory, not as documentation.
