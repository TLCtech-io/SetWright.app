-- Two access-layer hardenings from the adversarial review.
--
-- R-status: auth_member_tier — the helper every RLS policy leans on — checked only the member's
-- own status, never the ENSEMBLE's. So a 'suspended' or 'archived' ensemble (schema.sql models
-- both as the retirement path) kept full read+write access; archiving a tenant was cosmetic. Now
-- the tier resolves only for an ACTIVE ensemble, transparently denying every policy built on it.
-- (Archiving/reactivating an ensemble through the app therefore needs a service-role/admin path —
-- it is not exposed today; the column defaults to 'active', so no current behaviour changes.)
--
-- R-lastdir: the "an ensemble must keep one active director" invariant lived only in the app
-- repository (a read-then-write with no lock). A direct PostgREST write could demote/deactivate the
-- sole director and orphan the tenant, and two concurrent demotions could both pass. A constraint
-- trigger enforces it in the database, with FOR UPDATE to serialize concurrent attempts.

create or replace function auth_member_tier(p_ensemble uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select m.permission_tier
from public.member m
join public.ensemble e on e.id = m.ensemble_id
where m.ensemble_id = p_ensemble
and m.user_id = auth.uid()
and m.status = 'active'
and e.status = 'active'
limit 1;
$$;

create or replace function guard_last_director()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid := old.ensemble_id;
begin
-- Only act when this row IS the active director and is losing that status (demote/deactivate/
-- delete). FOR UPDATE locks the remaining active directors so concurrent demotions can't both
-- see a survivor that the other is removing.
if old.permission_tier = 'director' and old.status = 'active'
and (tg_op = 'DELETE' or new.permission_tier <> 'director' or new.status <> 'active')
and not exists (
    select 1 from public.member m
    where m.ensemble_id = v_ensemble
    and m.permission_tier = 'director'
    and m.status = 'active'
    and m.id <> old.id
    for update
) then
raise exception 'an ensemble must keep at least one active director';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger member_last_director_guard
before update or delete on public.member
for each row execute function guard_last_director();
