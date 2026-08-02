-- ============================================================================
-- hydrate_setlist_locks: read the pins for one setlist, for drafting into it.
-- Apply AFTER schema.sql and rls.sql.
--
-- A fresh draft ignores any setlist. To draft into a specific setlist, the API
-- reads its setlist_item pins here and maps them to the drafter's options:
-- pin 'open'/'close'/'keep' -> open / close / keep, is_excluded -> excluded.
--
-- This returns opens and closes as arrays. The schema does not stop a director
-- from pinning two songs to open, so the cardinality guard (at most one open,
-- at most one close) is the API's call. SQL reduces, TypeScript decides.
--
-- SECURITY INVOKER, like the draft hydration: the setlist and its items are read
-- as the signed-in caller, so RLS draws the tenant boundary. eventId comes back
-- null when the setlist is not found or not visible, which the API turns into a
-- 404. The schema keeps pins and is_excluded disjoint (one row per song), so the
-- four lists never overlap.
-- ============================================================================

create or replace function hydrate_setlist_locks(p_setlist uuid)
returns jsonb
language sql
stable
security invoker
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
