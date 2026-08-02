-- Make the whole song save transactional (remediation #6).
--
-- updateSong claimed the song row on its version (bumping updated_at), then wrote song_tag and
-- part rows in SEPARATE statements/transactions. A failure after the claim left the title changed
-- and the version advanced while the tags/parts were half-written -- a live probe left the title
-- changed, the version bumped, and every part deleted. Fold the claim + tag rewrite + part
-- reconciliation into ONE transaction: any constraint error rolls the entire save back, including
-- the version claim, exactly like the set_* collection RPCs (migration 9).
--
-- Returns {ok:true, version} or {ok:false, reason:'conflict'|'not_found'}. p_data carries the song
-- columns (snake_case), p_tags is an array of tag names, p_parts an array of part objects (each an
-- optional id + the part columns). SECURITY INVOKER: RLS scopes every touched row to the caller.
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
--    insert the new. A duplicate id updates once, then becomes an insert.
select coalesce(array_agg(id), '{}') into v_existing from public.part where song_id = p_song;
select coalesce(array_agg(distinct (e->>'id')::uuid), '{}')
into v_kept
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) e
where nullif(e->>'id', '') is not null and (e->>'id')::uuid = any(v_existing);
delete from public.part where song_id = p_song and not (id = any(v_kept));

for v_part in select * from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) loop
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
range_high    = (v_part->>'range_high')::smallint
where id = v_pid;
else
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high)
values (
    v_ensemble, p_song,
    v_part->>'label',
    (v_part->>'is_required')::boolean,
    (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid,
    (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint,
    (v_part->>'range_high')::smallint
);
end if;
end loop;

return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function save_song(uuid, timestamptz, jsonb, jsonb, jsonb) from public;
grant  execute on function save_song(uuid, timestamptz, jsonb, jsonb, jsonb) to authenticated;
