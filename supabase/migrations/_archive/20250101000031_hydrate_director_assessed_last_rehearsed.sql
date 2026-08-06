-- ============================================================================
-- Extend hydrate_draft_input with two signals the drafter now reads:
--   casting.director_assessed  -> readiness prefers the director's own read of a
--                                 cover over the member's self-report (Wave 1, item 1).
--   song.last_rehearsed        -> selection's staleness nudge: a ready song gone
--                                 cold sorts a touch under a fresh one (Wave 1, item 2).
--
-- Both are additive projection keys, named to match the core domain types, so the
-- API mapper stays a passthrough. director_assessed reads through casting_visible,
-- which already exposes it to directors only, so no RLS change is needed: a
-- non-director's draft sees null and falls back to the self-report, the same way
-- self_reported_confidence already varies by viewer under the privacy rule.
--
-- create or replace, not an edit to the original migration: …003 is already applied.
-- ============================================================================

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
    select s.id, s.title, s.assessed_readiness, s.book_status, s.is_explicit,
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
        'isExplicit', s.is_explicit, 'intensity', s.intensity,
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
