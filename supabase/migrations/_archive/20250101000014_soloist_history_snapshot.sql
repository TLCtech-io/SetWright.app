-- Make soloist history independent of the mutable rows it was derived from (remediation #5).
--
-- performance_soloist bound song_title/part_label/member_display_name only by FK to part and
-- member, both ON DELETE CASCADE. So a routine chart edit (which deletes + reinserts parts) or
-- removing a member silently erased that member's historical solo appearance -- a live probe
-- confirmed the cascade. History must not depend on the present.
--
-- Fix: denormalize the display fields onto the snapshot at perform time, and drop the cascading
-- FKs to part and member so deleting either no longer touches the historical row. The setlist FK
-- stays (cascade) -- but a performed setlist is itself protected from deletion by the immutability
-- guards (remediation #8) -- and the ensemble FK stays (a tenant teardown still cleans up).

-- 1. Denormalized history columns. Add nullable, backfill from the current rows, then NOT NULL.
alter table public.performance_soloist
add column song_title           text,
add column part_label           text,
add column member_display_name  text;

update public.performance_soloist ps
set song_title          = sg.title,
part_label          = coalesce(p.label, 'Solo'),
member_display_name = m.display_name
from public.song sg, public.part p, public.member m
where sg.id = ps.song_id and p.id = ps.part_id and m.id = ps.member_id;

-- Any snapshot whose source rows are already gone keeps a sensible non-null value.
update public.performance_soloist
set song_title          = coalesce(song_title, song_id::text),
part_label          = coalesce(part_label, 'Solo'),
member_display_name = coalesce(member_display_name, member_id::text)
where song_title is null or part_label is null or member_display_name is null;

alter table public.performance_soloist
alter column song_title          set not null,
alter column part_label          set not null,
alter column member_display_name set not null;

-- 2. Drop the cascading FKs to the mutable parents (part, member) by their referenced table,
--    so the auto-generated constraint names don't have to be hardcoded. The composite part FK
--    also covered song existence; that's fine -- song_title is denormalized now.
do $$
declare r record;
begin
for r in
select conname from pg_constraint
where conrelid = 'public.performance_soloist'::regclass
and contype = 'f'
and confrelid in ('public.part'::regclass, 'public.member'::regclass)
loop
execute format('alter table public.performance_soloist drop constraint %I', r.conname);
end loop;
end $$;

-- 3. perform_setlist records the denormalized snapshot (carries forward the row lock + safe-tz
--    fallback from migration 13).
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

-- Snapshot the featured lead of each solo part among the performed songs, denormalizing the
-- display fields so the record survives later deletion of the part, song, or member.
insert into public.performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id,
sg.title, coalesce(p.label, 'Solo'), m.display_name
from public.part p
join public.song    sg on sg.id = p.song_id
join public.casting c  on c.part_id = p.id and c.is_primary
join public.member  m  on m.id = c.member_id
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
