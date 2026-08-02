-- ============================================================================
-- Accompaniment policy (Wave 2, item 6). A cappella is the default; an event can
-- be marked a-cappella-only, and a chart can be marked as using accompaniment.
-- The context gate drops an accompanied chart at an a-cappella-only event, exactly
-- as it drops an explicit chart at an event that does not allow explicit.
--
-- Mirrors the is_explicit / allows_explicit / default_allows_explicit trio, with
-- ONE deliberate difference: the event and event-type flags default TRUE
-- (accompaniment is permitted unless a director turns it off), whereas the explicit
-- flags default false. The song flag defaults false (a cappella), like is_explicit.
--
-- create-or-replace, not an edit to the applied migrations: schema.sql (…001),
-- save_song (…016), the transactional writes (…024), the aggregate writes (…027),
-- and hydrate (…031) are all already applied. Columns first, then the functions
-- that reference them.
-- ============================================================================

alter table public.song       add column uses_accompaniment          boolean not null default false;
alter table public.event      add column allows_accompaniment        boolean not null default true;
alter table public.event_type add column default_allows_accompaniment boolean not null default true;


-- ----------------------------------------------------------------------------
-- hydrate_draft_input: project the two new signals the context gate reads
-- (song.uses_accompaniment, event.allows_accompaniment). Full re-declaration of
-- the …031 body with the two additions.
-- ----------------------------------------------------------------------------

create or replace function hydrate_draft_input(p_event uuid)
returns jsonb
language sql
stable
security invoker
as $$
with ev as (
    select e.id as event_id, e.ensemble_id, e.event_type_id, e.event_date,
    e.target_duration_seconds,
    e.allows_on_book,
    e.allows_explicit,
    e.allows_accompaniment,
    e.per_song_seconds,
    e.per_set_seconds
    from event e
    where e.id = p_event
),
exclude_tags as (
    select t.name from event_tag x join tag t on t.ensemble_id = x.ensemble_id and t.id = x.tag_id
    where x.ensemble_id = (select ensemble_id from ev) and x.event_id = p_event and x.effect = 'exclude'
),
prefer_tags as (
    select t.name from event_tag x join tag t on t.ensemble_id = x.ensemble_id and t.id = x.tag_id
    where x.ensemble_id = (select ensemble_id from ev) and x.event_id = p_event and x.effect = 'prefer'
),
members as (
    select m.id, m.display_name
    from member m
    where m.ensemble_id = (select ensemble_id from ev) and m.status = 'active' and m.is_singing
),
avail as (
    select a.member_id, a.status
    from availability a
    where a.ensemble_id = (select ensemble_id from ev) and a.event_id = p_event
    and a.member_id in (select id from members)
),
songs as (
    select s.id, s.title, s.assessed_readiness, s.book_status, s.is_explicit, s.uses_accompaniment,
    s.intensity, s.duration_seconds, s.last_performed, s.last_rehearsed,
    s.start_key_fifths, s.start_key_mode, s.end_key_fifths, s.end_key_mode,
    s.start_tempo_bpm, s.end_tempo_bpm
    from song s
    where s.ensemble_id = (select ensemble_id from ev) and s.status = 'active'
),
song_tags as (
    select st.song_id,
    jsonb_agg(jsonb_build_object('name', t.name, 'category', t.category)) as names
    from song_tag st join tag t on t.ensemble_id = st.ensemble_id and t.id = st.tag_id
    where st.ensemble_id = (select ensemble_id from ev) and st.song_id in (select id from songs)
    group by st.song_id
),
parts as (
    select p.id, p.song_id, p.is_required, p.count_needed,
    coalesce(p.label, vp.label, case when p.is_solo then 'Solo' end, 'part') as label
    from part p
    left join voice_part vp on vp.ensemble_id = p.ensemble_id and vp.id = p.voice_part_id
    where p.ensemble_id = (select ensemble_id from ev) and p.song_id in (select id from songs)
),
castings as (
    select cv.part_id, cv.member_id, cv.is_primary,
    cv.self_reported_confidence, cv.director_assessed
    from casting_visible cv
    where cv.ensemble_id = (select ensemble_id from ev) and cv.part_id in (select id from parts)
    and cv.member_id in (select id from members)
)
select jsonb_build_object(
    'event', (select jsonb_build_object(
        'id', event_id, 'eventDate', event_date,
        'targetDurationSeconds', target_duration_seconds,
        'allowsOnBook', allows_on_book, 'allowsExplicit', allows_explicit,
        'allowsAccompaniment', allows_accompaniment,
        'padding', jsonb_build_object('perSongSeconds', per_song_seconds, 'perSetSeconds', per_set_seconds))
        from ev),
    'excludeTags', coalesce((select jsonb_agg(name) from exclude_tags), '[]'::jsonb),
    'preferTags',  coalesce((select jsonb_agg(name) from prefer_tags), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'displayName', display_name)) from members), '[]'::jsonb),
    'availability', coalesce((select jsonb_agg(jsonb_build_object(
        'memberId', member_id, 'status', status)) from avail), '[]'::jsonb),
    'songs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'title', s.title,
        'assessedReadiness', s.assessed_readiness, 'bookStatus', s.book_status,
        'isExplicit', s.is_explicit, 'usesAccompaniment', s.uses_accompaniment, 'intensity', s.intensity,
        'durationSeconds', s.duration_seconds, 'lastPerformed', s.last_performed,
        'lastRehearsed', s.last_rehearsed,
        'startKey', case when s.start_key_fifths is null then null
        else jsonb_build_object('fifths', s.start_key_fifths, 'mode', s.start_key_mode) end,
        'endKey', case when s.end_key_fifths is null then null
        else jsonb_build_object('fifths', s.end_key_fifths, 'mode', s.end_key_mode) end,
        'startTempoBpm', s.start_tempo_bpm,
        'endTempoBpm', s.end_tempo_bpm,
        'tags', coalesce((select names from song_tags st where st.song_id = s.id), '[]'::jsonb)))
        from songs s), '[]'::jsonb),
    'parts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'songId', song_id, 'isRequired', is_required,
        'countNeeded', count_needed, 'label', label)) from parts), '[]'::jsonb),
    'castings', coalesce((select jsonb_agg(jsonb_build_object(
        'partId', part_id, 'memberId', member_id, 'isPrimary', is_primary,
        'confidence', self_reported_confidence,
        'directorAssessed', director_assessed)) from castings), '[]'::jsonb)
);
$$;

revoke all on function hydrate_draft_input(uuid) from public;
grant  execute on function hydrate_draft_input(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- create_song / save_song: write song.uses_accompaniment. Full re-declarations of
-- the …024 create_song and …016 save_song bodies with the one column added.
-- ----------------------------------------------------------------------------

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


-- ----------------------------------------------------------------------------
-- save_event / save_event_type: write allows_accompaniment / default_allows_accompaniment.
-- Full re-declarations of the …027 bodies with the one column added to each branch.
-- ----------------------------------------------------------------------------

create or replace function save_event(
    p_ensemble uuid,
    p_event    uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[]
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_event uuid;
begin
if p_event is null then
insert into public.event
(ensemble_id, name, venue, status, event_type_id, event_date, target_duration_seconds,
    allows_on_book, allows_explicit, allows_accompaniment, per_song_seconds, per_set_seconds)
values (
    p_ensemble, p_data->>'name', p_data->>'venue', p_data->>'status', (p_data->>'event_type_id')::uuid,
    (p_data->>'event_date')::date, (p_data->>'target_duration_seconds')::integer,
    (p_data->>'allows_on_book')::boolean, (p_data->>'allows_explicit')::boolean,
    (p_data->>'allows_accompaniment')::boolean,
    (p_data->>'per_song_seconds')::integer, (p_data->>'per_set_seconds')::integer)
returning id into v_event;
else
update public.event set
name = p_data->>'name', venue = p_data->>'venue', status = p_data->>'status',
event_type_id = (p_data->>'event_type_id')::uuid, event_date = (p_data->>'event_date')::date,
target_duration_seconds = (p_data->>'target_duration_seconds')::integer,
allows_on_book = (p_data->>'allows_on_book')::boolean,
allows_explicit = (p_data->>'allows_explicit')::boolean,
allows_accompaniment = (p_data->>'allows_accompaniment')::boolean,
per_song_seconds = (p_data->>'per_song_seconds')::integer,
per_set_seconds = (p_data->>'per_set_seconds')::integer
where ensemble_id = p_ensemble and id = p_event;
if not found then return null; end if;
v_event := p_event;
end if;

-- Tag rules: exclude wins over prefer. Resolve names to the ensemble's tags; unknown names drop.
delete from public.event_tag where ensemble_id = p_ensemble and event_id = v_event;
insert into public.event_tag (ensemble_id, event_id, tag_id, effect)
select p_ensemble, v_event, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude' else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}')) or t.name = any(coalesce(p_prefer, '{}')));

if p_event is null then
insert into public.availability (ensemble_id, member_id, event_id, status)
select p_ensemble, m.id, v_event, 'in'
from public.member m
where m.ensemble_id = p_ensemble and m.status = 'active' and m.is_singing;

insert into public.setlist (ensemble_id, event_id, name, status)
values (p_ensemble, v_event, 'Main set', 'draft');
end if;
return v_event;
end;
$$;
revoke all on function save_event(uuid, uuid, jsonb, text[], text[]) from public;
grant  execute on function save_event(uuid, uuid, jsonb, text[], text[]) to authenticated;


create or replace function save_event_type(
    p_ensemble uuid,
    p_type     uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[]
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_type uuid;
begin
if p_type is null then
insert into public.event_type
(ensemble_id, name, sort_order, padding_profile_id, default_allows_on_book,
    default_allows_explicit, default_allows_accompaniment)
values (
    p_ensemble, p_data->>'name', coalesce((p_data->>'sort_order')::smallint, 0),
    (p_data->>'padding_profile_id')::uuid,
    (p_data->>'default_allows_on_book')::boolean, (p_data->>'default_allows_explicit')::boolean,
    (p_data->>'default_allows_accompaniment')::boolean)
returning id into v_type;
else
update public.event_type set
name = p_data->>'name',
padding_profile_id = (p_data->>'padding_profile_id')::uuid,
default_allows_on_book = (p_data->>'default_allows_on_book')::boolean,
default_allows_explicit = (p_data->>'default_allows_explicit')::boolean,
default_allows_accompaniment = (p_data->>'default_allows_accompaniment')::boolean
where ensemble_id = p_ensemble and id = p_type;
if not found then return null; end if;
v_type := p_type;
end if;

delete from public.event_type_tag where ensemble_id = p_ensemble and event_type_id = v_type;
insert into public.event_type_tag (ensemble_id, event_type_id, tag_id, effect)
select p_ensemble, v_type, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude' else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}')) or t.name = any(coalesce(p_prefer, '{}')));
return v_type;
end;
$$;
revoke all on function save_event_type(uuid, uuid, jsonb, text[], text[]) from public;
grant  execute on function save_event_type(uuid, uuid, jsonb, text[], text[]) to authenticated;
