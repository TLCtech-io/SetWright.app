-- Serialize the freeze (remediation #3) + harden the timezone fallback (regression R6).
--
-- #3: the previous perform_setlist read s.status WITHOUT a row lock, so two concurrent
-- freezes both saw a non-performed status and both ran the snapshot+flip — the second
-- silently rewriting a supposedly frozen order. Take an explicit row lock on the setlist
-- (`for update of s`) BEFORE inspecting status: a competing call now blocks on that lock
-- and, under READ COMMITTED, re-reads the freshly committed status = 'performed' and bows
-- out (returns false). Exactly one freeze wins.
--
-- R6: migration 11 swapped the always-safe current_date fallback for
-- (now() at time zone en.timezone)::date. `at time zone` RAISES "time zone not recognized"
-- if en.timezone is not a value PostgreSQL knows, and ensemble.timezone has no DB CHECK
-- (only the app coercer guards it). A bad value (seed/service-role/future path) would wedge
-- the whole perform flow for that ensemble. Coalesce the zone to a known-good one
-- (validated against pg_timezone_names, else 'UTC') so the conversion can never throw.
--
-- Nothing else changes from migration 11; the child writes still happen before the parent
-- flips to 'performed', which keeps the perform RPC compatible with the immutability guards
-- added later (remediation #8).
create or replace function perform_setlist(p_setlist uuid, p_order uuid[])
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_date     date;
v_pos      int := 0;
v_song     uuid;
begin
select s.ensemble_id, s.status,
coalesce(
    e.event_date,
    (now() at time zone
        coalesce((select n.name from pg_timezone_names n where n.name = en.timezone), 'UTC')
    )::date)
into v_ensemble, v_status, v_date
from public.setlist s
join public.event e on e.ensemble_id = s.ensemble_id and e.id = s.event_id
join public.ensemble en on en.id = s.ensemble_id
where s.id = p_setlist
for update of s;

if v_ensemble is null then return false; end if;                 -- not found / not visible
if v_status = 'performed' then return false; end if;             -- immutable: never re-freeze
if p_order is null or array_length(p_order, 1) is null then return false; end if;  -- empty
if public.auth_member_tier(v_ensemble) is distinct from 'director' then return false; end if;

-- Freeze the order. Existing rows keep their note/transition_seconds (not in the
-- update list); songs without a row get one; anything not in the order is dropped.
foreach v_song in array p_order loop
v_pos := v_pos + 1;
insert into public.setlist_item (ensemble_id, setlist_id, song_id, position, is_excluded, pin)
values (v_ensemble, p_setlist, v_song, v_pos, false, null)
on conflict (setlist_id, song_id)
do update set position = excluded.position, is_excluded = false, pin = null;
end loop;
delete from public.setlist_item
where setlist_id = p_setlist and not (song_id = any(p_order));

-- Snapshot the featured lead of each solo part among the performed songs, so equity
-- stays true even if casting changes later.
insert into public.performance_soloist (ensemble_id, setlist_id, song_id, part_id, member_id)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id
from public.part p
join public.casting c on c.part_id = p.id and c.is_primary
where p.ensemble_id = v_ensemble and p.is_solo and p.song_id = any(p_order)
on conflict (setlist_id, part_id) do nothing;

update public.setlist set status = 'performed', performed_date = v_date where id = p_setlist;

update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(p_order);

return true;
end;
$$;

revoke all on function perform_setlist(uuid, uuid[]) from public;
grant  execute on function perform_setlist(uuid, uuid[]) to authenticated;
