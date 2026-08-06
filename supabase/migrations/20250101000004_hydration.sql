-- ============================================================================
-- Hydration: the two read functions that feed the core drafter.
--
--   hydrate_draft_input(uuid)   the event, the pool, the songs, the parts, the castings
--   hydrate_setlist_locks(uuid) the pins, exclusions, segue overrides and breaks
--
-- SQL reduces, TypeScript decides. Both do set-based work with fixed predicates:
-- resolve the event's policy, pull the active pool, project the rows the drafter
-- needs as one JSON document. Neither gates. Feasibility, readiness and context
-- all run in core, over rows these functions returned, because the shortfall can
-- only explain a drop for a song the core actually saw. The only filters applied
-- here are status = 'active' and, on the member pool, is_singing.
--
-- Both are SECURITY INVOKER. They confer no privilege: base-table RLS is
-- re-applied as the signed-in caller, and castings read through casting_visible,
-- which carries the confidence privacy rule. Call them with the user's client. The
-- service-role key is not a way around that and not a hazard either: neither function
-- grants execute to service_role, so calling one that way is a permission error rather
-- than a cross-tenant read.
--
-- Ordering. LANGUAGE sql bodies are parse-analyzed at creation, so every table
-- named below must already exist (001) and casting_visible must already be
-- defined (002). It also has to precede 008, which comments on both functions by
-- signature. Files 005 through 007 reference neither, so anywhere between 002 and 008
-- would work; it sits here because the drafter is the point of the schema and reads
-- best next to the policies that constrain it.
--
-- search_path. Both pin `pg_catalog, public, pg_temp`, which differs from every
-- other function in the baseline (`pg_catalog, pg_temp`). These two name their
-- tables unqualified, so public has to stay on the path. Naming pg_temp
-- explicitly still puts it last rather than the implicit first, which is the part
-- that carries the security weight. Getting this value wrong breaks the drafter
-- at runtime and no CI check reads the value, only its presence.
--
-- Replacing a function in place resets its configuration, so any future
-- redeclaration has to carry the SET clause in its own body or it silently drops
-- the pin.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- hydrate_draft_input: the read boundary between SQL and the core drafter.
--
-- The event owns its resolved policy and padding, snapshotted from its type at
-- create time, so the ev CTE reads the event's own columns and never coalesces
-- back to the type.
--
-- The returned JSON maps onto core's DraftInput almost field for field. The API
-- mapper folds excludeTags, preferTags and requireTags into options.context, since
-- DraftInput has no top-level field for any of the three. event, members,
-- availability, songs, parts and castings pass through by name.
--
-- director_assessed reads through casting_visible, which exposes it to directors
-- only. A non-director's draft sees null and falls back to the self-report, the
-- same way self_reported_confidence already varies by viewer.
-- ----------------------------------------------------------------------------
create or replace function hydrate_draft_input(p_event uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
with ev as (
    select e.id as event_id, e.ensemble_id, e.event_type_id, e.event_date,
    e.target_duration_seconds,
    e.max_duration_seconds,
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
        'maxDurationSeconds', max_duration_seconds,
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


-- ----------------------------------------------------------------------------
-- hydrate_setlist_locks: read the pins for one setlist, for drafting into it.
--
-- A fresh draft ignores any setlist. To draft into a specific setlist, the API
-- reads its setlist_item pins here and maps them to the drafter's options:
-- pin 'open'/'close'/'keep' -> open / close / keep, is_excluded -> excluded.
--
-- Opens and closes come back as arrays. The schema does not stop a director from
-- pinning two songs to open, so the cardinality guard (at most one open, at most
-- one close) is the API's call. SQL reduces, TypeScript decides.
--
-- eventId comes back null when the setlist is not found or not visible, which the
-- API turns into a 404. The schema keeps pins and is_excluded disjoint (one row
-- per song), so the four lists never overlap.
-- ----------------------------------------------------------------------------
create or replace function hydrate_setlist_locks(p_setlist uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
with sl as (
    select s.id as setlist_id, s.ensemble_id, s.event_id
    from setlist s
    where s.id = p_setlist
),
items as (
    select si.song_id, si.pin, si.is_excluded, si.transition_seconds
    from setlist_item si
    where si.ensemble_id = (select ensemble_id from sl)
    and si.setlist_id = p_setlist
),
brks as (
    select sb.id, sb.label, sb.duration_seconds, sb.after_position
    from setlist_break sb
    where sb.ensemble_id = (select ensemble_id from sl)
    and sb.setlist_id = p_setlist
)
select jsonb_build_object(
    'eventId',  (select event_id from sl),
    'opens',    coalesce((select jsonb_agg(song_id) from items where pin = 'open'),  '[]'::jsonb),
    'closes',   coalesce((select jsonb_agg(song_id) from items where pin = 'close'), '[]'::jsonb),
    'keep',     coalesce((select jsonb_agg(song_id) from items where pin = 'keep'),  '[]'::jsonb),
    'excluded', coalesce((select jsonb_agg(song_id) from items where is_excluded),   '[]'::jsonb),
    -- Per-song segue overrides: the gap LEAVING a song. Drives the key-clash decay and clock.
    'transitions', coalesce((select jsonb_agg(jsonb_build_object('songId', song_id, 'seconds', transition_seconds))
        from items where transition_seconds is not null), '[]'::jsonb),
    -- Breaks (intermissions) at ordinal slots: reduce the fill budget, split the order into segments.
    'breaks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'label', label,
        'durationSeconds', duration_seconds, 'afterPosition', after_position
    ) order by after_position) from brks), '[]'::jsonb)
);
$$;

revoke all on function hydrate_setlist_locks(uuid) from public;
grant  execute on function hydrate_setlist_locks(uuid) to authenticated;
