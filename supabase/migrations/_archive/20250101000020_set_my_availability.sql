-- ============================================================================
-- Workstream D: a member sets their OWN attendance for one event.
--
-- The director's set_availability replaces every member's row at once and rides an
-- event UPDATE (director-only). A member must not need that — they own a single row.
-- This is SECURITY INVOKER, so the availability_write self branch
-- (auth_is_self(member_id)) is what authorizes the write; the function only resolves the
-- caller's member + the event's ensemble and upserts the one row. A non-member, or a
-- status outside the domain, is rejected.
-- ============================================================================

create or replace function set_my_availability(p_event uuid, p_status text)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_member   uuid;
v_ensemble uuid;
begin
if p_status not in ('in', 'out', 'tentative') then
raise exception 'set_my_availability: invalid status %', p_status;
end if;

-- The event's ensemble (members can read events in their ensembles).
select ensemble_id into v_ensemble from public.event where id = p_event;
if v_ensemble is null then
raise exception 'set_my_availability: event not found';
end if;

-- The caller's own active member row in that ensemble.
select id into v_member
from public.member
where ensemble_id = v_ensemble and user_id = auth.uid() and status = 'active';
if v_member is null then
raise exception 'set_my_availability: not an active member of this ensemble';
end if;

-- One row per (member, event); flip its status if it already exists. The
-- availability_write RLS check (auth_is_self) gates this, since v_member is the caller.
insert into public.availability (ensemble_id, member_id, event_id, status, created_by, updated_by)
values (v_ensemble, v_member, p_event, p_status, auth.uid(), auth.uid())
on conflict (member_id, event_id)
do update set status = excluded.status, updated_by = auth.uid(), updated_at = now();
end;
$$;

revoke all on function set_my_availability(uuid, text) from public;
grant  execute on function set_my_availability(uuid, text) to authenticated;
