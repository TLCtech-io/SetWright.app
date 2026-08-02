-- Codex bug #2 (defense in depth): set_pins / set_item_field / set_breaks lock the parent setlist
-- but never assert it is a draft. The Next routes reject a locked (final/performed) set before
-- calling these, and the guard_performed_child triggers already block writes to a PERFORMED set's
-- children — but a 'final' set has no DB-level guard, so a director calling these RPCs directly via
-- PostgREST could edit a set the app considers locked. No tenant or role boundary is crossed (these
-- are SECURITY INVOKER and the child write policies are director-only), so this is a workflow /
-- read-only-record integrity guard, not an isolation fix.
--
-- Add a status = 'draft' assertion inside each RPC, holding the parent lock, so the DB rejects a
-- non-draft edit the way it already rejects a performed one. The app path never triggers this (it
-- guards status first), so no legitimate flow changes. Recreates each function otherwise verbatim
-- from its latest definition (set_pins: 024, set_item_field: 029, set_breaks: 009).

-- set_pins (024) + draft guard.
create or replace function set_pins(
    p_setlist  uuid,
    p_open     uuid,
    p_close    uuid,
    p_keep     uuid[],
    p_excluded uuid[]
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
begin
select ensemble_id, status into v_ensemble, v_status from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;  -- not found / not visible
if v_status <> 'draft' then
raise exception 'set_pins: setlist is not a draft' using errcode = '55000';
end if;

-- Snapshot the existing notes + segues before clearing the items.
create temp table _pin_meta on commit drop as
select song_id, note, transition_seconds
from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist;

delete from public.setlist_item where ensemble_id = v_ensemble and setlist_id = p_setlist;

insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
with src as (
    select distinct u.song_id
    from (
        select unnest(coalesce(array_remove(array[p_open, p_close] || coalesce(p_keep, '{}'::uuid[]), null), '{}'::uuid[])) as song_id
        union
        select unnest(coalesce(p_excluded, '{}'::uuid[]))
        union
        select song_id from _pin_meta
    ) u
)
select
v_ensemble, p_setlist, s.song_id,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null
when s.song_id = p_open  then 'open'
when s.song_id = p_close then 'close'
when s.song_id = any(coalesce(p_keep, '{}'::uuid[])) then 'keep'
else null end,
s.song_id = any(coalesce(p_excluded, '{}'::uuid[])),
m.note, m.transition_seconds,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null else 0 end
from src s
left join _pin_meta m on m.song_id = s.song_id
where s.song_id = any(coalesce(p_excluded, '{}'::uuid[]))
or s.song_id = p_open
or s.song_id = p_close
or s.song_id = any(coalesce(p_keep, '{}'::uuid[]))
or m.note is not null
or m.transition_seconds is not null;
end;
$$;
revoke all on function set_pins(uuid, uuid, uuid, uuid[], uuid[]) from public;
grant  execute on function set_pins(uuid, uuid, uuid, uuid[], uuid[]) to authenticated;

-- set_item_field (029) + draft guard.
create or replace function set_item_field(p_setlist uuid, p_song uuid, p_field text, p_note text, p_seconds int)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_cur      public.setlist_item%rowtype;
v_note     text;
v_seconds  int;
v_excluded boolean;
v_pin      text;
v_position smallint;
begin
if p_field not in ('note', 'transition') then
raise exception 'set_item_field: unknown field %', p_field;
end if;

select ensemble_id, status into v_ensemble, v_status from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;
if v_status <> 'draft' then
raise exception 'set_item_field: setlist is not a draft' using errcode = '55000';
end if;

select * into v_cur from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song
for update;

v_excluded := coalesce(v_cur.is_excluded, false);
v_pin      := v_cur.pin;
v_note     := case when p_field = 'note' then nullif(p_note, '') else v_cur.note end;
v_seconds  := case when p_field = 'transition' then p_seconds else v_cur.transition_seconds end;

-- No remaining reason to exist (no pin, not excluded, no note, no segue): drop the row.
if v_pin is null and not v_excluded and v_note is null and v_seconds is null then
delete from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song;
return;
end if;

-- The CHECK requires an excluded row to have null pin + null position, and a non-excluded row to
-- have a position; draft rows use the filler 0.
v_position := case when v_excluded then null else coalesce(v_cur.position, 0) end;
insert into public.setlist_item
(ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
values (
    v_ensemble, p_setlist, p_song,
    case when v_excluded then null else v_pin end, v_excluded, v_note, v_seconds, v_position)
on conflict (setlist_id, song_id) do update set
note = excluded.note,
transition_seconds = excluded.transition_seconds;
end;
$$;
revoke all on function set_item_field(uuid, uuid, text, text, int) from public;
grant  execute on function set_item_field(uuid, uuid, text, text, int) to authenticated;

-- set_breaks (009) + draft guard. The status is checked under the row lock BEFORE the optimistic
-- updated_at bump, so a non-draft is rejected without a side effect. Holding the lock also lets the
-- post-update "not found" mean only a version mismatch (the row provably exists), so it maps to a
-- clean conflict.
create or replace function public.set_breaks(p_setlist uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
v_status   text;
begin
select status into v_status from public.setlist where id = p_setlist for update;
if v_status is null then
return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
if v_status <> 'draft' then
raise exception 'set_breaks: setlist is not a draft' using errcode = '55000';
end if;

update public.setlist set updated_at = now()
where id = p_setlist and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
return jsonb_build_object('ok', false, 'reason', 'conflict');
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
