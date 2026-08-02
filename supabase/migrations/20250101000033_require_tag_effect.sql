-- ============================================================================
-- Required-material rule (Wave 2, item 7). A third tag effect, 'require', beside
-- 'prefer' and 'exclude'. It is a SET-LEVEL mandate enforced in core (the drafted
-- set must contain at least one song carrying each required tag); the DB only
-- persists the effect and hydrate surfaces the require list. exclude still wins,
-- then require, then prefer, for a tag named in more than one list.
--
-- Three parts: (1) widen both effect CHECK constraints; (2) re-declare
-- hydrate_draft_input (…032 body) with a require_tags CTE + requireTags key;
-- (3) DROP + recreate save_event / save_event_type with a new p_require text[] arg
-- (adding an argument changes the signature, so create-or-replace cannot do it in
-- place; the old 5-arg overload must be dropped or callers could bind the stale one).
-- ============================================================================

-- 1. Widen the effect vocabularies. The inline CHECKs from schema.sql are
--    Postgres-auto-named <table>_<column>_check.
alter table public.event_tag       drop constraint event_tag_effect_check;
alter table public.event_tag       add  constraint event_tag_effect_check
check (effect in ('prefer','exclude','require'));
alter table public.event_type_tag  drop constraint event_type_tag_effect_check;
alter table public.event_type_tag  add  constraint event_type_tag_effect_check
check (effect in ('prefer','exclude','require'));


-- 2. hydrate_draft_input: project a requireTags list beside excludeTags/preferTags.
--    Full re-declaration of the …032 body with the one CTE + one key added.
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
require_tags as (
    select t.name from event_tag x join tag t on t.ensemble_id = x.ensemble_id and t.id = x.tag_id
    where x.ensemble_id = (select ensemble_id from ev) and x.event_id = p_event and x.effect = 'require'
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
    'requireTags', coalesce((select jsonb_agg(name) from require_tags), '[]'::jsonb),
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


-- 3. save_event / save_event_type: accept a p_require text[] and resolve three-way
--    (exclude wins, then require, then prefer). Signature changes, so drop first.
drop function if exists save_event(uuid, uuid, jsonb, text[], text[]);
drop function if exists save_event_type(uuid, uuid, jsonb, text[], text[]);

create function save_event(
    p_ensemble uuid,
    p_event    uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[],
    p_require  text[]
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

-- Tag rules: exclude wins, then require, then prefer. Resolve names to the ensemble's
-- tags; unknown names drop.
delete from public.event_tag where ensemble_id = p_ensemble and event_id = v_event;
insert into public.event_tag (ensemble_id, event_id, tag_id, effect)
select p_ensemble, v_event, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude'
when t.name = any(coalesce(p_require, '{}')) then 'require'
else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}'))
    or t.name = any(coalesce(p_require, '{}'))
    or t.name = any(coalesce(p_prefer, '{}')));

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
revoke all on function save_event(uuid, uuid, jsonb, text[], text[], text[]) from public;
grant  execute on function save_event(uuid, uuid, jsonb, text[], text[], text[]) to authenticated;


create function save_event_type(
    p_ensemble uuid,
    p_type     uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[],
    p_require  text[]
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
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude'
when t.name = any(coalesce(p_require, '{}')) then 'require'
else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}'))
    or t.name = any(coalesce(p_require, '{}'))
    or t.name = any(coalesce(p_prefer, '{}')));
return v_type;
end;
$$;
revoke all on function save_event_type(uuid, uuid, jsonb, text[], text[], text[]) from public;
grant  execute on function save_event_type(uuid, uuid, jsonb, text[], text[], text[]) to authenticated;
