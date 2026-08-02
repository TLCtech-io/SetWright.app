# @repertoire/db

The parse-validation harness over the project's SQL. This package holds no SQL
itself. The canonical schema, row-level security, and RPCs live as Supabase
**migrations** at the repo root, `supabase/migrations/`, applied in lexicographic
(version-prefix) order.

That SQL is the contract the `core` domain types match, with no translation layer
between them. SQL reduces, TypeScript decides.

## Migrations

58 files. The first five lay the base contract:

1. `20250101000001_schema.sql` - tables, constraints, indexes, and the
   `updated_at` triggers.
2. `20250101000002_rls.sql` - row-level security, the SECURITY DEFINER helper
   functions (hardened: `search_path = pg_catalog, pg_temp`, schema-qualified,
   active-membership), the `casting_visible` view, and provisioning.
3. `20250101000003_hydrate_draft_input.sql` - the read function for a fresh draft
   of an event (`SECURITY INVOKER`). Depends on the tables and the view.
4. `20250101000004_hydrate_setlist_locks.sql` - reads one setlist's pins, for
   drafting into a specific setlist. Same dependencies.
5. `20250101000005_mark_setlist_performed.sql` - the original performed-write,
   superseded by `perform_setlist` in migration 6 and dropped in migration 12.

The other 53 add tables, columns, constraints, and policies on top of that base,
and redeclare functions in place. `hydrate_draft_input` is redeclared through
migration 34, `perform_setlist` through migration 48. So the base five are not the
schema in force: read the whole set.

Applied migrations are immutable. Never edit one, add a new migration. The series
is hand-maintained, so take the next number by hand rather than using
`supabase migration new`, which stamps a real timestamp and breaks the ordering.

Apply against the local stack with `supabase db reset`, which drops, re-applies
every migration in order, then loads `supabase/seed.sql`. The integration suite
does not use that: it resets data over the live connection with
`supabase/test-reset.sql`, because dropping the database mid-run severs GoTrue's
connection and the token endpoint starts returning 502. The schema depends on the
`auth` schema (`auth.users`, `auth.uid()`), which Supabase provides.

## Validation

No database is needed to check the SQL parses: `npm test` runs every migration in
`supabase/migrations/` through libpg_query, the actual PostgreSQL parser. That
catches grammar errors, not semantic ones. Live validation, applying the
migrations and calling the functions against the `auth` schema and real data, is
`supabase db reset` against the local stack.

## The boundary

`hydrate_draft_input(p_event uuid)` returns one JSON document that maps onto
`core`'s `DraftInput` almost field for field. It runs `SECURITY INVOKER`, so
base-table RLS applies to the signed-in caller and castings read through
`casting_visible`. The API mapper folds `excludeTags` / `preferTags` / `requireTags`
into `options.context`; everything else lines up by name.

To draft into a specific setlist, `hydrate_setlist_locks(p_setlist uuid)` returns
that setlist's pins (`opens` / `closes` / `keep` / `excluded`) plus its `eventId`.
The API reads the pins, maps them to the drafter's options, and calls the draft
hydration for the event.

`perform_setlist(p_setlist uuid, p_order uuid[], p_snapshot jsonb)` is the
performed-write. It freezes the running order into `setlist_item`, snapshots the
featured soloists into `performance_soloist`, sets the setlist's status to
`performed`, stamps `performed_date`, and stamps `last_performed` on the songs it
ran (which feeds the recency penalty on the next draft). It returns false when the
setlist is not found, not visible, already performed, or the order is empty; the
director-write RLS authorizes the writes. (The legacy `mark_setlist_performed`,
which stamped `last_performed` but wrote no order or soloists, was dropped in
migration 12.)
