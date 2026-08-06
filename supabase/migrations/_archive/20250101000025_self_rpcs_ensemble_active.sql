-- Gate the member self-service RPCs on the ensemble being active (#3).
--
-- R-status made auth_member_tier resolve only for an active ensemble, so every policy built on it
-- denies a suspended/archived tenant. But the self-service paths route around that helper: they
-- authorize on the member's own row (auth_is_self / a user_id match), which stays 'active' even
-- when the ENSEMBLE is archived. So a member of an archived ensemble could still edit their
-- profile, set confidence, or RSVP. Add an ensemble-active check to all three, so archiving a
-- tenant freezes self-writes too, consistent with the shared-data policies. (Reactivation is a
-- service-role/admin path, not exposed today; the column defaults to 'active', so live data is
-- unaffected.)

-- Confidence: SECURITY DEFINER, so it bypasses RLS — the explicit ensemble check is the only gate.
create or replace function set_my_confidence(p_casting uuid, p_confidence text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.casting c
set self_reported_confidence = p_confidence,
updated_by = auth.uid()
where c.id = p_casting
and exists (
    select 1 from public.member m
    join public.ensemble e on e.id = m.ensemble_id and e.status = 'active'
    where m.id = c.member_id and m.user_id = auth.uid()
    and m.status = 'active'
);
end;
$$;

-- Profile: SECURITY DEFINER. display_name coalesces; the range fields set directly; tier, status,
-- and the account link stay untouchable here.
create or replace function update_my_profile(
    p_member uuid,
    p_display_name text,
    p_range_low smallint,
    p_range_high smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.member m
set display_name     = coalesce(p_display_name, m.display_name),
vocal_range_low  = p_range_low,
vocal_range_high = p_range_high,
updated_by       = auth.uid()
where m.id = p_member and m.user_id = auth.uid()
and m.status = 'active'
and exists (select 1 from public.ensemble e where e.id = m.ensemble_id and e.status = 'active');
end;
$$;

-- Availability: SECURITY INVOKER (the availability_write self branch authorizes it), but that RLS
-- branch is auth_is_self too, so the ensemble status must be checked here. Resolve the caller's
-- member only when their ensemble is active; otherwise v_member stays null and the call is rejected.
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
end;
$$;
