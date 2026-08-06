# Archived migrations

The 64-file migration set that built the schema up to 2026-08-06, kept verbatim.

**These are never applied.** The Supabase CLI does not recurse into subdirectories of
`supabase/migrations/`, and the two repo scripts that enumerate migrations
(`packages/db/test/validate.ts`, `scripts/check-search-path-pins.mjs`) both read the directory
non-recursively and keep only `*.sql`, so a directory entry is skipped. Verified against CLI
2.109.1 before this folder was created.

## Why they are here

The live schema is now a baseline: eight files, one declaration per object. That set records
what the schema *is*. These 64 record *why*, and a good deal of the why is not recoverable from
the result. A few examples:

- `20250101000062_casting_visible_barrier.sql` carries the measured EXPLAIN output behind the
  `security_barrier` decision, including the concern it disproved.
- `20250101000059_hydrate_search_path_pins.sql` explains why the two hydration functions are
  pinned by ALTER rather than in their bodies, and what a redeclaration silently loses.
- `20250101000047_member_invite_side_table.sql` names the exact read a member could perform
  before the invite address moved to a director-only table.
- `20250101000045_prune_member_coverage_set_based.sql` is the reason deactivating a member is
  destructive rather than a flag flip.

Deleting this folder would keep every outcome and lose every reason, which is how a decision
gets quietly reversed later by someone who cannot see it was a decision.

## Reading them

Apply order is lexicographic by filename, which is also numeric here. A function declared in
several files is live only in the highest-numbered one: `hydrate_draft_input` appears five times
and only `...034` was in force. Treat any single file as a snapshot of intent on the day it was
written, not as a statement about the current schema. Several of them were already contradicted
by later files before this archive was made.

The baseline these were collapsed into was proven equivalent by dumping the schema from a stack
with all 64 applied, resetting onto the new set, and diffing the two dumps to zero.
