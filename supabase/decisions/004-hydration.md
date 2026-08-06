# 004 Hydration

Covers `supabase/migrations/20250101000004_hydration.sql`: `hydrate_draft_input(uuid)` and
`hydrate_setlist_locks(uuid)`.

Archived originals: `supabase/migrations/_archive/20250101000003_hydrate_draft_input.sql`,
`_archive/20250101000004_hydrate_setlist_locks.sql`, and the four redeclarations
(`_archive/20250101000031..034`), plus `_archive/20250101000059_hydrate_search_path_pins.sql`
and `_archive/20250101000062_casting_visible_barrier.sql`.

## Why these gate nothing

SQL reduces, TypeScript decides. Both functions do set-based work with fixed predicates and no
policy. The only filters `hydrate_draft_input` applies are `status = 'active'` on songs and
members, plus `is_singing` on the member pool.

The reason is not purity. The drafter's output is a funnel plus a shortfall, and the shortfall
can only explain a drop for a song core actually saw. A gate moved into SQL removes the row
before core can name the lever, so the director gets a shorter set with no explanation. Every
feasibility, readiness and context decision therefore runs in `packages/core/src/drafter/`, over
rows these functions returned.

The same rule shapes `hydrate_setlist_locks`. It returns `opens` and `closes` as arrays even
though a usable set has at most one of each, because the schema does not stop a director from
pinning two songs to open. Rejecting that is a policy call, so it sits in the API:
`packages/api/src/endpoint.ts` returns 422 when either array holds more than one. Adding a
cardinality constraint to the schema, or a `limit 1` here, would turn an explainable 422 into a
silently dropped pin.

## The pool is projected separately from availability, and that is load-bearing

`members` is the full active singing roster. `avail` is only the availability rows for people
already in that roster. A member with no availability row still appears in `members`.

That asymmetry exists for the chase lever (`packages/core/src/drafter/chase.ts`). Chase drafts
twice and diffs the feasibility drops: the baseline counts who said in, the optimistic pass
counts everyone who has not said out, including roster members with no row at all. Without the
roster projected independently, chase falls back to tentatives only and cannot tell the director
that the missing Alto 2 simply has not replied.

The trap that follows: `is_singing = false` removes a member from `members`, from `avail`, and
from `castings`, all in SQL. Core never learns that person exists, so no shortfall and no chase
target can name them. If a director marks a singer non-singing and then wonders why a song they
cover keeps dropping, nothing in the draft output will say so. That is a deliberate cost of
keeping the pool filter here rather than in core, but it is the one place where a SQL filter
does hide a lever.

## The event reads its own columns, never its type

The `ev` CTE reads `event.target_duration_seconds`, `max_duration_seconds`, the three `allows_*`
flags and the two padding columns directly, with no coalesce back to `event_type`. The drafter
reads one row for policy.

Where the values come from is app-side, not SQL-side. `save_event`
(`20250101000005_rpc_director.sql`) writes every one of those columns straight from its `p_data`
payload and reads no event-type default. The copy from a type's defaults happens in the web form:
automatically on the first type pick of a new event while the form is untouched, and on demand
via the Apply button when editing an existing event. Nothing in the database propagates a type
change to events that already exist, and nothing propagates it to an event whose form was never
Applied.

`ev` also selects `e.event_type_id` and never uses it. It is projected into no key and read by no
later CTE. Harmless, and a leftover from the shape where the type would have been coalesced in.

## SECURITY INVOKER, and what the service-role key actually does here

Both functions are `SECURITY INVOKER`. That is the default, and it is stated in the file because
it is load-bearing: base-table RLS re-applies as the signed-in caller, and castings read through
`casting_visible`, which carries the confidence privacy rule.

An older version of this comment said calling them with the service-role key destroys tenant
isolation. It does not. Verified against the live database, `proacl` on both functions is
`{postgres=X/postgres,authenticated=X/postgres}`. `service_role` holds no EXECUTE, so that call
is a permission error, not a cross-tenant read. Use the user's client because it is the only
thing that works, not because the alternative leaks.

`casting_visible` is the piece that does run with elevated rights. It is owned by `postgres`,
has no `security_invoker`, and `casting` does not force row security on its owner, so the view
bypasses `casting`'s RLS. Its `WHERE auth_member_tier(c.ensemble_id) is not null` is the tenant
guard and its `CASE` arms are the confidence guard. Anything added to that view inherits the
same responsibility.

## The search_path pin, and why its value differs from every other function

Both functions pin `search_path = pg_catalog, public, pg_temp`. Counted on the live database, the
other 49 functions in `public` pin `pg_catalog, pg_temp`. The only unpinned function in `public`
is `moddatetime`, which comes from the extension.

The difference is forced by the bodies. These two name their tables unqualified (`event`,
`member`, `song`, `casting_visible`), so `public` has to stay on the path or the function fails
at runtime. Naming `pg_temp` explicitly still places it last rather than at the implicit front,
which is the part that carries the security weight. Qualifying every table name instead would
let them use the narrow pin, at the cost of rewriting two long bodies for uniformity alone.

Nothing catches a wrong value. `scripts/check-search-path-pins.mjs` tests only
`/set\s+search_path/i` against the declaration header, so it proves a pin exists and says nothing
about what it is. It is a CI-only step (`.github/workflows/ci.yml`), not part of `npm run verify`.
The `packages/db` parse harness that `verify` does run validates that the SQL parses, which a
wrong pin does. Change this value and the first thing that notices is the drafter, in production.

## What a redeclaration loses

`CREATE OR REPLACE FUNCTION` resets a function's configuration. A redeclaration that does not
repeat the `SET search_path` clause in its own header silently drops the pin, and nothing in the
schema records that anything was lost. This is not hypothetical: `hydrate_draft_input` was
redeclared five times in the archive (003, 031, 032, 033, 034).

The archive resolved this by pinning with `ALTER FUNCTION` (059) rather than redeclaring, on the
grounds that the bodies are long and copying them forward to change one attribute is how a schema
and its copy drift. The baseline reverses that and carries the pin inline on both declarations.
The trade is real in both directions. Inline, the pin cannot be separated from the body it
protects, but it also cannot be corrected by an `ALTER` a reader of this file would never see.
Out of line, the body stays untouched, but the next redeclaration silently undoes it.

Either way, the rule for the next edit is the same: if you redeclare either function, the `SET`
clause goes in the new header. The CI check is the backstop, and it only catches the total
absence of a pin.

## Why the draft body grew five times

There is no partial replace for a SQL function body, so every new signal core gates on cost a
full copy of the previous body. The four additions, and what each one bought:

- **031** projected `casting.director_assessed` and `song.last_rehearsed`. Readiness prefers the
  director's read of a cover over the member's self-report; selection gains a staleness nudge so
  a ready song gone cold sorts slightly under a fresh one. `director_assessed` needed no RLS
  change, because `casting_visible` already exposes it to directors only. A non-director's draft
  sees null and falls back to the self-report, the same way `self_reported_confidence` already
  varies by viewer.
- **032** projected `song.uses_accompaniment` and `event.allows_accompaniment`. It mirrors the
  `is_explicit` / `allows_explicit` pair with one deliberate inversion, confirmed against the live
  column defaults: the event and event-type accompaniment flags default `true` (permitted unless
  a director turns it off), where both explicit flags default `false`. The song flag defaults
  `false` in both pairs.
- **033** added the `require` tag effect and its CTE. It is a set-level mandate enforced in core:
  the drafted set must contain at least one song carrying each required tag. SQL only persists the
  effect and surfaces the list. Precedence for a tag named in more than one list is fixed in
  `save_event`: exclude wins, then require, then prefer.
- **034** projected `event.max_duration_seconds`, a hard ceiling distinct from the soft
  `target_duration_seconds`. The two-tier behaviour lives in core: fill and trim honour the
  tighter of the two, and the shortfall names the over-cap overshoot the trim cannot pull, such as
  pins, forced keeps and long segues.

The API mapper stayed a near-passthrough through all of this because each key was named to match
the core domain type. `packages/api/src/mapper.ts` folds `excludeTags`, `preferTags` and
`requireTags` into `options.context`, since `DraftInput` has no top-level field for any of the
three. `event`, `members`, `availability`, `songs`, `parts` and `castings` pass through by name.
Adding a projection key that does not match a core field name breaks that property and is worth
avoiding.

## The casting_visible barrier, and the constraint it puts on the castings CTE

The castings CTE is the drafter's hottest read and it goes through `casting_visible`. Marking
that view `security_barrier` was held back from the review that produced it, because a barrier
view refuses to push caller quals down unless they are leakproof. The worry was that the ensemble
filter would stop reaching the base scan, turning the CTE into a cross-tenant scan of `casting`
with a per-row `SECURITY DEFINER` call.

It was measured before shipping rather than assumed, on a seeded stack, as an authenticated
director, against the exact query shape the CTE uses. The recorded plans, from
`_archive/20250101000062_casting_visible_barrier.sql`:

- without the barrier: index scan on `idx_casting_part`, with `c.ensemble_id = (InitPlan 1).col1`
  and the tier check as a post-filter
- with the barrier: index scan on `idx_casting_ensemble`, with the ensemble equality as the index
  condition

The filter reaches the base scan either way, and with the barrier it reaches it as an index
condition rather than a post-filter. The reason is that `(select ensemble_id from ev)` is
uncorrelated, so the planner evaluates it once as an InitPlan constant and the qual reduces to a
leakproof equality that is pushdown-safe into a barrier view. A correlated sub-select would not
be, which is what the general rule about barrier views is actually about.

Those plans are not reproducible on a development database. The local stack holds 12 casting rows,
far below any index crossover, so a fresh EXPLAIN measures nothing. What can still be checked is
the structure the measurement depended on: `casting_visible` still carries `security_barrier=true`, both
`idx_casting_part` and `idx_casting_ensemble` exist, and the CTE's ensemble predicate is still
the uncorrelated sub-select.

That last point is the constraint on future edits. Keep the ensemble predicate an uncorrelated
sub-select against `ev`. Correlate it, and the qual stops being pushdown-safe through the
barrier, and the plan regresses to the shape the barrier was expected to cause. The remaining
accepted cost is that quals which genuinely are not pushdown-safe stay outside the view. On this
view that is the two `in (select ...)` predicates, which already planned as joins before the
barrier landed.

## Where the file sits, and why

`LANGUAGE sql` bodies are parse-analyzed at creation, so the ordering is not free. Every table
named here must already exist (001) and `casting_visible` must already be defined (002). The file
must also precede 008, which comments on both functions by signature.

Files 005, 006 and 007 reference neither function, so anywhere between 002 and 008 would apply
cleanly. It sits at 004 because the drafter is the point of the schema and reads best next to the
policies that constrain it.
