-- Codex security #3: the playground (program / program_item) is the director's private drafting
-- space — the page layer bounces members off /playground and the API is requireDirector — but the
-- base RLS read policies (migration 002's common "any active member reads" pattern) still let a
-- member SELECT program / program_item directly through PostgREST, exposing the director's proposed
-- song order and open/close/keep pins.
--
-- Tighten both reads to director-only, matching the audience the rest of the stack already enforces
-- and the precedent migration 041 set for unpublished setlists. Writes were already director-only.
-- Not a cross-tenant leak (auth_member_tier scopes to the caller's ensemble), so this only removes
-- within-tenant member visibility. Validate under the live stack (verify:full) before relying on it.

drop policy program_read on program;
create policy program_read on program
for select using (auth_member_tier(ensemble_id) = 'director');

drop policy program_item_read on program_item;
create policy program_item_read on program_item
for select using (auth_member_tier(ensemble_id) = 'director');
