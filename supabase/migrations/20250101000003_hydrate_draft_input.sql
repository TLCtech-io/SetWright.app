-- ============================================================================
-- hydrate_draft_input: the read boundary between SQL and the core drafter.
-- Apply AFTER schema.sql and rls.sql.
--
-- SQL reduces, TypeScript decides. This does set-based work with fixed
-- predicates: resolve event policy, pull the active pool, and project the rows
-- the drafter needs as one JSON document. It does NOT gate. The only filter is
-- status = 'active' on songs and members. Every drop the shortfall explains
-- happens in core, over rows this function returned.
--
-- SECURITY INVOKER (the default, stated here because it is load-bearing): the
-- function runs as the caller, so base-table RLS applies and castings read
-- through casting_visible, which holds the confidence privacy rule. Call it with
-- the signed-in user's client, never the service-role key, or tenant isolation
-- is gone.
--
-- The returned JSON maps onto core's DraftInput almost field for field. The API
-- mapper folds excludeTags / preferTags into options.context; everything else
-- lines up by name.
--
-- Out of this first cut: the setlist_item read for locks (open / close / keep /
-- excluded). That attaches when drafting into a specific setlist_id.
-- ============================================================================

create or replace function hydrate_draft_input(p_event uuid)
returns jsonb
language sql
stable
security invoker
as $$
with ev as (
    -- The event owns its resolved policy + padding (snapshotted from its type at
    -- create time), so this reads the event's own columns — no coalesce to the type.
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
    -- Event-level only: the type's standing rules were snapshotted into event_tag at create.
    select t.name from event_tag x join tag t on t.ensemble_id = x.ensemble_id and t.id = x.tag_id
    where x.ensemble_id = (select ensemble_id from ev) and x.event_id = p_event and x.effect = 'exclude'
),
prefer_tags as (
    select t.name from event_tag x join tag t on t.ensemble_id = x.ensemble_id and t.id = x.tag_id
    where x.ensemble_id = (select ensemble_id from ev) and x.event_id = p_event and x.effect = 'prefer'
),
members as (
    -- The singing pool: active members who actually perform. A non-singing member
    -- (is_singing = false) keeps platform access but never enters a draft.
    select m.id, m.display_name
    from member m
    where m.ensemble_id = (select ensemble_id from ev) and m.status = 'active' and m.is_singing
),
avail as (
    -- Scoped to the singing pool, so an inactive or non-singing member with a
    -- stale RSVP never counts toward the available set.
    select a.member_id, a.status
    from availability a
    where a.ensemble_id = (select ensemble_id from ev) and a.event_id = p_event
    and a.member_id in (select id from members)
),
songs as (
    select s.id, s.title, s.assessed_readiness, s.book_status, s.is_explicit,
    s.intensity, s.duration_seconds, s.last_performed,
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
    -- Scoped to the singing pool, so coverage from an inactive or non-singing
    -- member never lets a part read as covered.
    select cv.part_id, cv.member_id, cv.is_primary, cv.self_reported_confidence
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
        'confidence', self_reported_confidence)) from castings), '[]'::jsonb)
);
$$;

revoke all on function hydrate_draft_input(uuid) from public;
grant  execute on function hydrate_draft_input(uuid) to authenticated;
