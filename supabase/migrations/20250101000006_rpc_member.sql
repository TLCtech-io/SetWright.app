-- ============================================================================
-- Member self-service RPCs.
--
-- Three functions a member calls on their own rows: their RSVP for one event,
-- the confidence on their own casting, and their own profile.
--
-- They sit in their own file because they are a distinct trust class. Each is
-- SECURITY DEFINER, and the whole authorization is an internal check written
-- into the body: the target row must belong to auth.uid(), the member row must
-- be 'active', and the ensemble must be 'active'. There is no RLS behind them.
-- Read the predicate on each statement as the access rule, because it is.
--
-- The ensemble check is not redundant with the policies. Those route through
-- auth_member_tier, which resolves only for an active ensemble; the self-service
-- paths authorize on the caller's own member row instead, and that row stays
-- 'active' when the tenant is archived. Without the explicit check, archiving a
-- tenant would freeze shared writes but leave self-writes open.
--
-- Ordering: depends on the tables and the availability unique key from 001. It
-- does not depend on the policies in 002, by design. The casting confidence
-- guard trigger in 003 sees these writes as self writes and lets them through.
-- ============================================================================


-- A member sets their own attendance for one event.
--
-- The director's bulk set_availability replaces every member's row at once and rides an
-- UPDATE on event, which is director-only. A member owns a single row and must not need
-- that path.
--
-- SECURITY DEFINER for one specific reason: the final statement advances event.updated_at,
-- which the director-only event_write policy would refuse. That token is the optimistic
-- concurrency check the director's bulk save guards on, and moddatetime is per-table, so a
-- write to availability alone never moves it. Leaving it unmoved meant the director's next
-- guarded save did not see the member's RSVP and its replace silently overwrote it. Moving
-- it makes that save conflict with a 409 and reload. The cost is that this function's own
-- checks are now the only gate on it.
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

    -- The caller's own active member row in that ensemble, and only if the tenant is live.
    select m.id into v_member
    from public.member m
    join public.ensemble e on e.id = m.ensemble_id and e.status = 'active'
    where m.ensemble_id = v_ensemble and m.user_id = auth.uid() and m.status = 'active';
    if v_member is null then
        raise exception 'set_my_availability: not an active member of this ensemble';
    end if;

    -- One row per (member, event); flip its status if it already exists.
    insert into public.availability (ensemble_id, member_id, event_id, status, created_by, updated_by)
    values (v_ensemble, v_member, p_event, p_status, auth.uid(), auth.uid())
    on conflict (member_id, event_id)
    do update set status = excluded.status, updated_by = auth.uid(), updated_at = now();

    -- Advance the event's concurrency token so a director's guarded bulk save detects this
    -- change. It touches updated_at and nothing else, on the one event just RSVP'd to
    -- (moddatetime also fires, so the net is updated_at = now()).
    update public.event set updated_at = now() where id = p_event;
end;
$$;

revoke all on function set_my_availability(uuid, text) from public;
grant  execute on function set_my_availability(uuid, text) to authenticated;


-- A member sets or clears the confidence on their own casting. Null is allowed, meaning
-- un-report; the value itself is checked by casting's own CHECK constraint.
--
-- The parameter is the PART, not the casting id, and that is load-bearing. The client used
-- to resolve its casting id in one round trip and write it in a second. A concurrent
-- director casting save delete+reinserts those rows with fresh ids, so the pre-resolved id
-- went stale and the member's write updated zero rows and was silently dropped. Resolving
-- by (part, caller's member) inside a single statement always hits the current row, because
-- the director's delete+insert is atomic with respect to it.
create or replace function set_my_confidence(p_part uuid, p_confidence text)
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


-- A member edits their display name and vocal range on one of their member rows.
--
-- display_name coalesces, since it is NOT NULL and a null argument means "leave it". The
-- range fields are set directly, so a null argument clears them. Tier, status, and the
-- account link are not reachable here, which is the point of routing profile edits through
-- a function instead of a table write.
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

revoke all on function update_my_profile(uuid, text, smallint, smallint) from public;
grant  execute on function update_my_profile(uuid, text, smallint, smallint) to authenticated;
