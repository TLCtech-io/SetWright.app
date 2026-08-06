-- Part display order.
--
-- Directors enter a song's parts in whatever order comes to mind, and a part split
-- is often discovered after the fact, so the song and casting screens need a way to
-- reorder them. The drafter is order-agnostic by design (it sorts parts by id and the
-- hydration carries no ORDER BY), so this column is display-only: the song editor and
-- the casting screen read it, no gate depends on it.
--
-- Mirrors voice_part.sort_order. There is no reorder RPC: the client already sends its
-- parts in visual order, so both write functions stamp sort_order from the array index
-- (with ordinality). A reorder is just "reorder the array and re-save".

alter table public.part
add column sort_order smallint not null default 0;

-- Backfill so songs entered before this migration get a stable order from their
-- creation order, instead of all tying at 0.
update public.part p
set sort_order = t.rn
from (
    select id, (row_number() over (partition by song_id order by created_at, id) - 1) as rn
    from public.part
) t
where p.id = t.id;

-- Re-declare the two part writers to persist the array order. Only the parts loop
-- changes (with ordinality -> sort_order); the rest matches the 032 bodies.

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
v_ord  bigint;
begin
insert into public.song
(ensemble_id, title, arranger, chart_ref, start_key_fifths, start_key_mode, end_key_fifths,
    end_key_mode, start_tempo_bpm, end_tempo_bpm, start_pitch, duration_seconds, is_explicit,
    uses_accompaniment, intensity, assessed_readiness, book_status, last_rehearsed)
values (
    p_ensemble,
    p_data->>'title', p_data->>'arranger', p_data->>'chart_ref',
    (p_data->>'start_key_fifths')::smallint, p_data->>'start_key_mode',
    (p_data->>'end_key_fifths')::smallint, p_data->>'end_key_mode',
    (p_data->>'start_tempo_bpm')::smallint, (p_data->>'end_tempo_bpm')::smallint,
    p_data->>'start_pitch', (p_data->>'duration_seconds')::integer,
    (p_data->>'is_explicit')::boolean, (p_data->>'uses_accompaniment')::boolean,
    (p_data->>'intensity')::smallint,
    p_data->>'assessed_readiness', p_data->>'book_status', (p_data->>'last_rehearsed')::date)
returning id into v_song;

insert into public.song_tag (ensemble_id, song_id, tag_id)
select distinct p_ensemble, v_song, t.id
from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) as submitted(tag_name)
join public.tag t on t.ensemble_id = p_ensemble and t.name = submitted.tag_name;

for v_part, v_ord in
select value, ordinality
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) with ordinality as t(value, ordinality)
loop
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high, sort_order)
values (
    p_ensemble, v_song,
    v_part->>'label', (v_part->>'is_required')::boolean, (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid, (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint, (v_part->>'range_high')::smallint,
    (v_ord - 1)::smallint);
end loop;

return jsonb_build_object('ok', true, 'id', v_song);
end;
$$;

revoke all on function create_song(uuid, jsonb, jsonb, jsonb) from public;
grant  execute on function create_song(uuid, jsonb, jsonb, jsonb) to authenticated;


create or replace function save_song(
    p_song     uuid,
    p_expected timestamptz,
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
v_ensemble uuid;
v_version  timestamptz;
v_existing uuid[];
v_kept     uuid[];
v_seen     uuid[] := '{}';
v_part     jsonb;
v_ord      bigint;
v_pid      uuid;
begin
-- 1. Claim the song row on the expected version (moddatetime bumps updated_at, the new token).
update public.song set
title              = p_data->>'title',
arranger           = p_data->>'arranger',
chart_ref          = p_data->>'chart_ref',
start_key_fifths   = (p_data->>'start_key_fifths')::smallint,
start_key_mode     = p_data->>'start_key_mode',
end_key_fifths     = (p_data->>'end_key_fifths')::smallint,
end_key_mode       = p_data->>'end_key_mode',
start_tempo_bpm    = (p_data->>'start_tempo_bpm')::smallint,
end_tempo_bpm      = (p_data->>'end_tempo_bpm')::smallint,
start_pitch        = p_data->>'start_pitch',
duration_seconds   = (p_data->>'duration_seconds')::integer,
is_explicit        = (p_data->>'is_explicit')::boolean,
uses_accompaniment = (p_data->>'uses_accompaniment')::boolean,
intensity          = (p_data->>'intensity')::smallint,
assessed_readiness = p_data->>'assessed_readiness',
book_status        = p_data->>'book_status',
last_rehearsed     = (p_data->>'last_rehearsed')::date
where id = p_song and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_version;
if not found then
if exists (select 1 from public.song where id = p_song)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;

-- 2. Rewrite song_tag from the submitted names (resolved to tag ids in this ensemble; unknown
--    names are simply dropped, as the adapter did).
delete from public.song_tag where song_id = p_song;
insert into public.song_tag (ensemble_id, song_id, tag_id)
select distinct v_ensemble, p_song, t.id
from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) as submitted(tag_name)
join public.tag t on t.ensemble_id = v_ensemble and t.name = submitted.tag_name;

-- 3. Reconcile parts (mirror writeParts): keep ids that still name a part of this song (so
--    their castings survive), drop the rest (castings cascade via FK), update kept in place,
--    insert the new. A duplicate id updates once, then becomes an insert. sort_order comes
--    from the array index, so the submitted visual order is what persists.
select coalesce(array_agg(id), '{}') into v_existing from public.part where song_id = p_song;
select coalesce(array_agg(distinct (e->>'id')::uuid), '{}')
into v_kept
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) e
where nullif(e->>'id', '') is not null and (e->>'id')::uuid = any(v_existing);
delete from public.part where song_id = p_song and not (id = any(v_kept));

for v_part, v_ord in
select value, ordinality
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) with ordinality as t(value, ordinality)
loop
v_pid := nullif(v_part->>'id', '')::uuid;
if v_pid is not null and v_pid = any(v_existing) and not (v_pid = any(v_seen)) then
v_seen := v_seen || v_pid;
update public.part set
label         = v_part->>'label',
is_required   = (v_part->>'is_required')::boolean,
count_needed  = (v_part->>'count_needed')::smallint,
voice_part_id = (v_part->>'voice_part_id')::uuid,
is_solo       = (v_part->>'is_solo')::boolean,
range_low     = (v_part->>'range_low')::smallint,
range_high    = (v_part->>'range_high')::smallint,
sort_order    = (v_ord - 1)::smallint
where id = v_pid;
else
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high, sort_order)
values (
    v_ensemble, p_song,
    v_part->>'label',
    (v_part->>'is_required')::boolean,
    (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid,
    (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint,
    (v_part->>'range_high')::smallint,
    (v_ord - 1)::smallint
);
end if;
end loop;

return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function save_song(uuid, timestamptz, jsonb, jsonb, jsonb) from public;
grant  execute on function save_song(uuid, timestamptz, jsonb, jsonb, jsonb) to authenticated;
