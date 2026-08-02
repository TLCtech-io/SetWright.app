-- ============================================================================
-- Column ownership for casting.self_reported_confidence (G2.1).
--
-- The director writes a casting's assignment (is_primary) and their own read
-- (director_assessed), but the cast MEMBER alone owns self_reported_confidence — set
-- only through set_my_confidence. RLS is row-level, so the director-write policy can't
-- exclude that one column. This trigger does: if anyone other than the cast member
-- changes self_reported_confidence on an UPDATE, the old value is kept. Service/seed
-- contexts have no JWT (auth.uid() is null) and are left alone, so seeding still sets
-- it. set_my_confidence runs as the member (auth.uid() = them), so it passes.
--
-- INSERT is intentionally not guarded: a brand-new casting has no prior self-report to
-- overwrite, and the adapter preserves the member's prior value across its delete+
-- reinsert (so a director re-saving castings never clobbers a self-report either).
-- ============================================================================

create or replace function guard_casting_confidence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if new.self_reported_confidence is distinct from old.self_reported_confidence
and auth.uid() is not null
and not public.auth_is_self(new.member_id) then
new.self_reported_confidence := old.self_reported_confidence;
end if;
return new;
end;
$$;

create trigger casting_confidence_owner
before update on casting
for each row execute function guard_casting_confidence();
