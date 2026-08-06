-- Make two more aggregate writes transactional (B4). Each ran as separate PostgREST requests
-- (autocommitted), so a failure mid-sequence left corruption.
--
-- set_pins replaced a draft's items by deleting them all and re-inserting the pin/exclusion state
-- with the per-song notes/segues preserved — but the delete committed before the insert, so a
-- failing insert (e.g. a pinned song since deleted -> FK violation) wiped every note, segue, and
-- pin. create_song committed the parent song before its parts, so a child failure stranded an
-- active ghost song with no parts. Both now run in one function (one transaction): any error
-- rolls the whole thing back. SECURITY INVOKER, so RLS scopes every touched row to the caller.

-- Replace a draft's pins + exclusions, preserving notes/segues — atomically. Mirrors
-- setPinsImpl: a row is kept only if it is excluded, pinned, or carries a note/segue.
create or replace function set_pins(
    p_setlist  uuid,
    p_open     uuid,
    p_close    uuid,
    p_keep     uuid[],
    p_excluded uuid[]
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
begin
select ensemble_id into v_ensemble from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;  -- not found / not visible

-- Snapshot the existing notes + segues before clearing the items.
create temp table _pin_meta on commit drop as
select song_id, note, transition_seconds
from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist;

delete from public.setlist_item where ensemble_id = v_ensemble and setlist_id = p_setlist;

insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
with src as (
    select distinct u.song_id
    from (
        select unnest(coalesce(array_remove(array[p_open, p_close] || coalesce(p_keep, '{}'::uuid[]), null), '{}'::uuid[])) as song_id
        union
        select unnest(coalesce(p_excluded, '{}'::uuid[]))
        union
        select song_id from _pin_meta
    ) u
)
select
v_ensemble, p_setlist, s.song_id,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null
when s.song_id = p_open  then 'open'
when s.song_id = p_close then 'close'
when s.song_id = any(coalesce(p_keep, '{}'::uuid[])) then 'keep'
else null end,
s.song_id = any(coalesce(p_excluded, '{}'::uuid[])),
m.note, m.transition_seconds,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null else 0 end
from src s
left join _pin_meta m on m.song_id = s.song_id
where s.song_id = any(coalesce(p_excluded, '{}'::uuid[]))
or s.song_id = p_open
or s.song_id = p_close
or s.song_id = any(coalesce(p_keep, '{}'::uuid[]))
or m.note is not null
or m.transition_seconds is not null;
end;
$$;

revoke all on function set_pins(uuid, uuid, uuid, uuid[], uuid[]) from public;
grant  execute on function set_pins(uuid, uuid, uuid, uuid[], uuid[]) to authenticated;

-- Create a song with its tags + parts atomically. p_data carries the song columns (snake_case),
-- p_tags the tag names, p_parts the part objects. Returns {ok:true, id}. RLS (song_write etc.)
-- gates every insert to a director of p_ensemble.
create or replace function create_song(
    p_ensemble uuid,
    p_data     jsonb,
    p_tags     jsonb,
    p_parts    jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_song uuid;
v_part jsonb;
begin
insert into public.song
(ensemble_id, title, arranger, chart_ref, start_key_fifths, start_key_mode, end_key_fifths,
    end_key_mode, start_tempo_bpm, end_tempo_bpm, start_pitch, duration_seconds, is_explicit,
    intensity, assessed_readiness, book_status, last_rehearsed)
values (
    p_ensemble,
    p_data->>'title', p_data->>'arranger', p_data->>'chart_ref',
    (p_data->>'start_key_fifths')::smallint, p_data->>'start_key_mode',
    (p_data->>'end_key_fifths')::smallint, p_data->>'end_key_mode',
    (p_data->>'start_tempo_bpm')::smallint, (p_data->>'end_tempo_bpm')::smallint,
    p_data->>'start_pitch', (p_data->>'duration_seconds')::integer,
    (p_data->>'is_explicit')::boolean, (p_data->>'intensity')::smallint,
    p_data->>'assessed_readiness', p_data->>'book_status', (p_data->>'last_rehearsed')::date)
returning id into v_song;

insert into public.song_tag (ensemble_id, song_id, tag_id)
select distinct p_ensemble, v_song, t.id
from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) as submitted(tag_name)
join public.tag t on t.ensemble_id = p_ensemble and t.name = submitted.tag_name;

for v_part in select * from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) loop
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high)
values (
    p_ensemble, v_song,
    v_part->>'label', (v_part->>'is_required')::boolean, (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid, (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint, (v_part->>'range_high')::smallint);
end loop;

return jsonb_build_object('ok', true, 'id', v_song);
end;
$$;

revoke all on function create_song(uuid, jsonb, jsonb, jsonb) from public;
grant  execute on function create_song(uuid, jsonb, jsonb, jsonb) to authenticated;
