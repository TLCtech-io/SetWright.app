-- Transactional optimistic-concurrency writes for the three "replace the whole collection"
-- operations: availability, breaks, and casting. Each claims its parent row by bumping
-- updated_at ONLY if it still equals the caller's token, then rewrites the child collection
-- IN THE SAME TRANSACTION, so the parent row lock taken by the guarded UPDATE is held across
-- the delete + insert. A concurrent same-token writer blocks on that lock and then sees the
-- bumped version (0 rows -> conflict), so exactly one writer wins; and a failed rewrite rolls
-- back the claim, so the token never advances without the data. This replaces the adapter's
-- earlier claim-then-replace across separate autocommit statements, which could lose updates.
--
-- SECURITY INVOKER: RLS still scopes every touched row to the caller's ensemble. On a stale or
-- absent parent nothing is written and the function returns {ok:false, reason}. moddatetime sets
-- updated_at = now() on the UPDATE; the RETURNING value is the fresh token handed back.

-- Availability (parent: event). Rows: [{ memberId, status }].
create or replace function public.set_availability(p_event uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
begin
update public.event set updated_at = now()
where id = p_event and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
if exists (select 1 from public.event where id = p_event)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;
delete from public.availability where event_id = p_event;
insert into public.availability (ensemble_id, member_id, event_id, status)
select v_ensemble, (r->>'memberId')::uuid, p_event, r->>'status'
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_availability(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_availability(uuid, timestamptz, jsonb) to authenticated;

-- Breaks (parent: setlist). Rows: [{ label, durationSeconds, afterPosition }].
create or replace function public.set_breaks(p_setlist uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
begin
update public.setlist set updated_at = now()
where id = p_setlist and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
if exists (select 1 from public.setlist where id = p_setlist)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;
delete from public.setlist_break where setlist_id = p_setlist;
insert into public.setlist_break (ensemble_id, setlist_id, label, duration_seconds, after_position)
select v_ensemble, p_setlist, r->>'label', (r->>'durationSeconds')::integer, (r->>'afterPosition')::smallint
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_breaks(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_breaks(uuid, timestamptz, jsonb) to authenticated;

-- Casting (parent: song). Rows: [{ partId, memberId, isPrimary, directorAssessed }].
-- self_reported_confidence is the member's column: preserved from the prior row, never the
-- payload. learned_at: keep the prior date while a cover stays solid, stamp now when it newly
-- becomes solid, else null (mirrors the adapter's old JS derivation, now atomic).
create or replace function public.set_song_casting(p_song uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
v_prior    jsonb;
begin
update public.song set updated_at = now()
where id = p_song and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
if exists (select 1 from public.song where id = p_song)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;

-- Snapshot the prior castings for this song's parts BEFORE deleting, keyed by part:member.
select coalesce(
    jsonb_object_agg(
        c.part_id::text || ':' || c.member_id::text,
        jsonb_build_object('src', c.self_reported_confidence, 'da', c.director_assessed, 'la', c.learned_at)
    ),
    '{}'::jsonb)
into v_prior
from public.casting c
where c.part_id in (select id from public.part where song_id = p_song);

delete from public.casting
where part_id in (select id from public.part where song_id = p_song);

insert into public.casting (ensemble_id, part_id, member_id, is_primary, self_reported_confidence, director_assessed, learned_at)
select
v_ensemble,
(r->>'partId')::uuid,
(r->>'memberId')::uuid,
coalesce((r->>'isPrimary')::boolean, false),
p.src,
nullif(r->>'directorAssessed', '')::text,
case
when (r->>'directorAssessed') = 'solid'
then case when p.da = 'solid' then coalesce(p.la, now()) else now() end
else null
end
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
left join lateral (
    select
    v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'src'              as src,
    v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'da'               as da,
    (v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'la')::timestamptz as la
) p on true
where (r->>'partId')::uuid in (select id from public.part where song_id = p_song);

return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_song_casting(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_song_casting(uuid, timestamptz, jsonb) to authenticated;
