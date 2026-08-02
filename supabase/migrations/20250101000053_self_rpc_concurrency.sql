-- Self-RPC concurrency fixes (Bug2, Bug3 from the second-pass audit).
--
-- Both are director+member lost-update races the optimistic-concurrency system fails to catch.

-- Bug2: a member's self-RSVP writes only the `availability` child table, so event.updated_at never
-- moves (moddatetime is per-table). The director's bulk RSVP save (set_availability) guards on
-- event.updated_at, so it does NOT detect the member's write and its REPLACE silently overwrites it.
-- Fix: advance event.updated_at when a member RSVPs, so the director's guarded save conflicts (409)
-- and reloads instead of clobbering. The member cannot update the event row under the director-only
-- event_write RLS, so the function moves to SECURITY DEFINER — matching the other self-RPCs
-- (set_my_confidence, update_my_profile), which are already DEFINER with an internal auth check. The
-- internal checks are unchanged: it resolves the caller's own active member row and only ever writes
-- that member's availability row + touches the event it just RSVP'd to.
create or replace function set_my_availability(p_event uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_member   uuid;
v_ensemble uuid;
begin
if p_status not in ('in', 'out', 'tentative') then
raise exception 'set_my_availability: invalid status %', p_status;
end if;

select ensemble_id into v_ensemble from public.event where id = p_event;
if v_ensemble is null then
raise exception 'set_my_availability: event not found';
end if;

select m.id into v_member
from public.member m
join public.ensemble e on e.id = m.ensemble_id and e.status = 'active'
where m.ensemble_id = v_ensemble and m.user_id = auth.uid() and m.status = 'active';
if v_member is null then
raise exception 'set_my_availability: not an active member of this ensemble';
end if;

insert into public.availability (ensemble_id, member_id, event_id, status, created_by, updated_by)
values (v_ensemble, v_member, p_event, p_status, auth.uid(), auth.uid())
on conflict (member_id, event_id)
do update set status = excluded.status, updated_by = auth.uid(), updated_at = now();

-- Advance the event's optimistic-concurrency token so a director's guarded bulk save detects this
-- change. DEFINER bypasses the director-only event_write RLS; it only touches updated_at of the
-- event the caller just RSVP'd to (moddatetime also fires, so the net is updated_at = now()).
update public.event set updated_at = now() where id = p_event;
end;
$$;
revoke all on function set_my_availability(uuid, text) from public;
grant  execute on function set_my_availability(uuid, text) to authenticated;

-- Bug3: the client resolved the member's casting id in one round trip, then wrote it in a second.
-- A concurrent director casting save (set_song_casting) delete+reinserts the casting rows with fresh
-- ids, so the pre-resolved id goes stale and the member's write updates 0 rows — silently dropped.
-- Fix: resolve the casting by (part_id, caller's member) INSIDE the RPC, in one atomic statement, so
-- it always hits the current row (transaction isolation makes the director's delete+insert atomic
-- w.r.t. this single update). The param changes from a casting id to a part id, so drop + recreate.
drop function if exists set_my_confidence(uuid, text);
create function set_my_confidence(p_part uuid, p_confidence text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.casting c
set self_reported_confidence = p_confidence,
updated_by = auth.uid()
where c.part_id = p_part
and exists (
    select 1 from public.member m
    join public.ensemble e on e.id = m.ensemble_id and e.status = 'active'
    where m.id = c.member_id and m.user_id = auth.uid()
    and m.status = 'active'
);
end;
$$;
revoke all on function set_my_confidence(uuid, text) from public;
grant  execute on function set_my_confidence(uuid, text) to authenticated;
