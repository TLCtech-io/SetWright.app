-- Rehearsal planner, follow-up: kind-guard save_attendance.
--
-- Attendance is recorded through the rehearsal-only "Record rehearsal" route, but the RPC
-- itself had no kind guard, so an authenticated director could call it directly for a gig
-- and persist attendance rows the UI never intends. The sibling RPCs (save_rehearsal_agenda,
-- save_prep_targets) already guard kind; this brings save_attendance in line. Full
-- re-declaration of the …038 body; only the kind lookup + guard are added.
create or replace function save_attendance(p_event uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_kind     text;
begin
select ensemble_id, kind into v_ensemble, v_kind from public.event where id = p_event for update;
if v_ensemble is null then return; end if;
if v_kind is distinct from 'rehearsal' then
raise exception 'save_attendance: event % is not a rehearsal', p_event;
end if;

delete from public.attendance where ensemble_id = v_ensemble and event_id = p_event;
insert into public.attendance (ensemble_id, member_id, event_id, present)
select v_ensemble, d.member_id, p_event, d.present
from (
    select distinct on ((att.value->>'member_id')::uuid)
    (att.value->>'member_id')::uuid as member_id,
    (att.value->>'present')::boolean as present
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as att(value, ordinality)
    order by (att.value->>'member_id')::uuid, att.ordinality desc
) d;
end;
$$;
revoke all on function save_attendance(uuid, jsonb) from public;
grant  execute on function save_attendance(uuid, jsonb) to authenticated;
