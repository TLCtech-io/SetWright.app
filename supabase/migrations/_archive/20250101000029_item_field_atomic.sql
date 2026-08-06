-- Round-3 lower-priority hardening.
--
-- L1a: setItemNote / setTransition did a read-modify-upsert of the WHOLE setlist_item row, so two
-- concurrent edits to different fields of the same song (one note, one segue) clobbered each other.
-- set_item_field locks the row and merges in one transaction, setting only the named field.
-- L1b: perform_setlist unnested the entire p_order before slicing to 512, so a direct PostgREST
-- call with a huge array materialized it all. Cap the input array up front.

-- Atomically set one field (note or segue) on a draft's setlist_item, preserving the rest, and drop
-- the row when nothing is left to anchor it. SECURITY INVOKER, so RLS scopes the write to a director
-- of the setlist's ensemble. The FOR UPDATE row lock serializes concurrent edits.
create or replace function set_item_field(p_setlist uuid, p_song uuid, p_field text, p_note text, p_seconds int)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_cur      public.setlist_item%rowtype;
v_note     text;
v_seconds  int;
v_excluded boolean;
v_pin      text;
v_position smallint;
begin
if p_field not in ('note', 'transition') then
raise exception 'set_item_field: unknown field %', p_field;
end if;

select ensemble_id into v_ensemble from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;

select * into v_cur from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song
for update;

v_excluded := coalesce(v_cur.is_excluded, false);
v_pin      := v_cur.pin;
v_note     := case when p_field = 'note' then nullif(p_note, '') else v_cur.note end;
v_seconds  := case when p_field = 'transition' then p_seconds else v_cur.transition_seconds end;

-- No remaining reason to exist (no pin, not excluded, no note, no segue): drop the row.
if v_pin is null and not v_excluded and v_note is null and v_seconds is null then
delete from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song;
return;
end if;

-- The CHECK requires an excluded row to have null pin + null position, and a non-excluded row to
-- have a position; draft rows use the filler 0.
v_position := case when v_excluded then null else coalesce(v_cur.position, 0) end;
insert into public.setlist_item
(ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
values (
    v_ensemble, p_setlist, p_song,
    case when v_excluded then null else v_pin end, v_excluded, v_note, v_seconds, v_position)
on conflict (setlist_id, song_id) do update set
note = excluded.note,
transition_seconds = excluded.transition_seconds;
end;
$$;
revoke all on function set_item_field(uuid, uuid, text, text, int) from public;
grant  execute on function set_item_field(uuid, uuid, text, text, int) to authenticated;

-- L1b: perform_setlist with an up-front cap on the input array, so a direct call can't materialize
-- an unbounded unnest before the dedupe slices to 512. Otherwise identical to migration 28.
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
v_order    uuid[];
begin
perform set_config('app.perform_writer', 'rpc', true);
p_order := p_order[1:2048]; -- bound the input before unnest; the dedupe below slices to 512

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

if v_ensemble is null then return false; end if;
if v_status = 'performed' then return false; end if;
if p_order is null or array_length(p_order, 1) is null then return false; end if;
if public.auth_member_tier(v_ensemble) is distinct from 'director' then return false; end if;

v_order := (
    select array_agg(song_id order by first_ord)
    from (
        select song_id, min(ord) as first_ord
        from unnest(p_order) with ordinality as u(song_id, ord)
        group by song_id
    ) d
);
v_order := v_order[1:512];

insert into public.setlist_item (ensemble_id, setlist_id, song_id, position, is_excluded, pin)
select v_ensemble, p_setlist, s.song_id, s.rn::int, false, null
from unnest(v_order) with ordinality as s(song_id, rn)
on conflict (setlist_id, song_id)
do update set position = excluded.position, is_excluded = false, pin = null;

delete from public.setlist_item
where setlist_id = p_setlist and not (song_id = any(v_order));

insert into public.performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id,
sg.title, coalesce(p.label, 'Solo'), m.display_name
from public.part p
join public.song    sg on sg.id = p.song_id
join public.casting c  on c.part_id = p.id and c.is_primary
join public.member  m  on m.id = c.member_id
where p.ensemble_id = v_ensemble and p.is_solo and p.song_id = any(v_order)
on conflict (setlist_id, part_id) do nothing;

update public.setlist set status = 'performed', performed_date = v_date where id = p_setlist;
update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(v_order);
return true;
end;
$$;
revoke all on function perform_setlist(uuid, uuid[]) from public;
grant  execute on function perform_setlist(uuid, uuid[]) to authenticated;
