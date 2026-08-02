-- ============================================================================
-- mark_setlist_performed: close the performed loop. Apply AFTER schema.sql and
-- rls.sql.
--
-- Marking a setlist performed stamps last_performed on the songs it actually
-- ran, which feeds the drafter's recency penalty so a recurring audience does
-- not hear the same numbers every time. The schema leaves this to application
-- logic on purpose; this is that logic.
--
-- The performance date is the event's date, or today if the event has no date.
-- last_performed takes the greatest of its current value and this date, so a
-- more recent performance elsewhere is never backdated. Only non-excluded items
-- are stamped; an excluded song was barred from the set, not sung.
--
-- SECURITY INVOKER: the writes run as the caller, so the director-write RLS on
-- song and setlist is the authorization guard. A non-director's writes are
-- filtered to zero rows by RLS, so the data is never touched without rights.
-- The return value follows the write, not read-visibility: false when the
-- setlist is not found, not visible, or the caller cannot write it (a non-
-- director, whose UPDATE touches zero rows). So a false success never reports a
-- performance that did not happen.
-- ============================================================================

create or replace function mark_setlist_performed(p_setlist uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
v_ensemble uuid;
v_date     date;
begin
select e.ensemble_id, coalesce(e.event_date, current_date)
into v_ensemble, v_date
from setlist s
join event e on e.ensemble_id = s.ensemble_id and e.id = s.event_id
where s.id = p_setlist;

if v_ensemble is null then
return false; -- not found or not visible
end if;

update setlist set status = 'performed' where id = p_setlist;
if not found then
return false; -- visible, but RLS wrote nothing: the caller is not a director
end if;

update song
set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble
and id in (
    select si.song_id
    from setlist_item si
    where si.setlist_id = p_setlist and not si.is_excluded
);

return true;
end;
$$;

revoke all on function mark_setlist_performed(uuid) from public;
grant  execute on function mark_setlist_performed(uuid) to authenticated;
