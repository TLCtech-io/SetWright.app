-- Protect self_reported_confidence on INSERT too, without breaking set_song_casting (remediation #9).
--
-- The member alone owns casting.self_reported_confidence. Migration 7's trigger guarded only
-- UPDATE, so a director could change a member's stored self-report by DELETE + INSERT of the
-- casting (a live probe did exactly that through the RLS-scoped API). The obvious fix -- null the
-- column on any non-self INSERT -- would BREAK set_song_casting: on every director re-save it
-- DELETEs and re-INSERTs each casting with the member's PRESERVED prior value (p.src), running as
-- the director (not-self), so a blanket INSERT guard would wipe every member's self-report.
--
-- So set_song_casting signals its legitimate preserved re-insert with a transaction-local GUC
-- (app.casting_writer = 'rpc'), and the trigger trusts only that. is_local = true means the GUC
-- resets at transaction end, so it never leaks across pooled requests; a raw director INSERT (a
-- different transaction) carries no such flag and is guarded. The member's own set_my_confidence
-- path is an UPDATE as self (auth_is_self) and is unaffected; seed/service writes have no JWT.

create or replace function public.guard_casting_confidence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if tg_op = 'INSERT' then
-- set_song_casting re-inserting the member's preserved value, vouched for by its txn-local flag.
if coalesce(current_setting('app.casting_writer', true), '') = 'rpc' then
return new;
end if;
-- Anyone else: the cast member may seed their own confidence; a director/other may not.
if new.self_reported_confidence is not null
and auth.uid() is not null
and not public.auth_is_self(new.member_id) then
new.self_reported_confidence := null;
end if;
return new;
end if;

-- UPDATE (unchanged from migration 7): keep the prior value if anyone but the member changes it.
if new.self_reported_confidence is distinct from old.self_reported_confidence
and auth.uid() is not null
and not public.auth_is_self(new.member_id) then
new.self_reported_confidence := old.self_reported_confidence;
end if;
return new;
end;
$$;

drop trigger if exists casting_confidence_owner on public.casting;
create trigger casting_confidence_owner
before insert or update on public.casting
for each row execute function public.guard_casting_confidence();

-- Re-create set_song_casting with the bypass flag set before it touches casting. Everything else
-- is unchanged from migration 9 (claim song version, snapshot prior, replace the collection,
-- preserve self_reported_confidence from the prior row, derive learned_at).
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
-- Vouch for this function's preserved re-inserts so the confidence-owner trigger trusts them
-- (txn-local: resets at commit, never leaks to another request).
perform set_config('app.casting_writer', 'rpc', true);

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
