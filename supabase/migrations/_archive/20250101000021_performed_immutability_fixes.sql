-- Close two holes in performed-history immutability surfaced by adversarial review (B3).
--
-- (a) MOVE-OUT: guard_performed_child resolved the parent status from NEW.setlist_id only, so a
--     director could UPDATE a frozen child (setlist_item / setlist_break / performance_soloist)
--     to RE-PARENT it onto a draft set — NEW points at the draft, the guard sees 'draft', and the
--     frozen row is silently pulled out of history. Now the guard checks BOTH the old and the new
--     parent: any write touching a performed parent on either side is blocked.
--
-- (b) DIRECT FLIP: guard_performed_setlist only blocked writes to an ALREADY-performed set, so a
--     director could PATCH a draft straight to status='performed', bypassing perform_setlist and
--     producing a "performed" set with no frozen order, no soloist snapshots, and a null
--     performed_date. Now only perform_setlist may make that transition — it vouches with a
--     txn-local GUC (app.perform_writer = 'rpc', same pattern as set_song_casting's
--     app.casting_writer) — and a CHECK constraint guarantees a performed row always has a date.

-- (a) Child guard: block when EITHER the old or the new parent setlist is performed. A legitimate
-- cascade from deleting a non-performed parent still passes (the parent row is already gone, so the
-- lookup finds no row). perform_setlist writes its children while the parent is still 'draft', so it
-- is unaffected.
create or replace function guard_performed_child()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_status text;
begin
if tg_op in ('UPDATE', 'DELETE') then
select s.status into v_status from public.setlist s where s.id = old.setlist_id;
if v_status = 'performed' then
raise exception 'performed setlist history is immutable';
end if;
end if;
if tg_op in ('INSERT', 'UPDATE') then
select s.status into v_status from public.setlist s where s.id = new.setlist_id;
if v_status = 'performed' then
raise exception 'cannot write into a performed setlist';
end if;
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- (b) Parent guard: still immutable once performed, AND a draft->performed flip is allowed only
-- when perform_setlist vouches for it (txn-local flag). is_local resets at commit, so it never
-- leaks across pooled requests; a raw director PATCH carries no flag and is blocked.
create or replace function guard_performed_setlist()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if old.status = 'performed' then
raise exception 'performed setlists are immutable';
end if;
if tg_op = 'UPDATE' and new.status = 'performed'
and coalesce(current_setting('app.perform_writer', true), '') <> 'rpc' then
raise exception 'a setlist can only be performed through perform_setlist';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- A performed setlist must carry its performance date — defence in depth against any path that
-- sets status='performed' without one. perform_setlist always sets both in one UPDATE.
alter table public.setlist
add constraint setlist_performed_has_date
check (status <> 'performed' or performed_date is not null);

-- Recreate perform_setlist to vouch for its own status flip with the txn-local flag. Identical to
-- migration 14 (the current version: row lock, safe-tz fallback, denormalized soloist snapshot)
-- except for the one set_config line.
create or replace function perform_setlist(p_setlist uuid, p_order uuid[])
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_date     date;
v_pos      int := 0;
v_song     uuid;
begin
-- Vouch for the draft->performed flip below so guard_performed_setlist trusts it (txn-local).
perform set_config('app.perform_writer', 'rpc', true);

select s.ensemble_id, s.status,
coalesce(
    e.event_date,
    (now() at time zone
        coalesce((select n.name from pg_timezone_names n where n.name = en.timezone), 'UTC')
    )::date)
into v_ensemble, v_status, v_date
from public.setlist s
join public.event e on e.ensemble_id = s.ensemble_id and e.id = s.event_id
join public.ensemble en on en.id = s.ensemble_id
where s.id = p_setlist
for update of s;

if v_ensemble is null then return false; end if;
if v_status = 'performed' then return false; end if;
if p_order is null or array_length(p_order, 1) is null then return false; end if;
if public.auth_member_tier(v_ensemble) is distinct from 'director' then return false; end if;

foreach v_song in array p_order loop
v_pos := v_pos + 1;
insert into public.setlist_item (ensemble_id, setlist_id, song_id, position, is_excluded, pin)
values (v_ensemble, p_setlist, v_song, v_pos, false, null)
on conflict (setlist_id, song_id)
do update set position = excluded.position, is_excluded = false, pin = null;
end loop;
delete from public.setlist_item
where setlist_id = p_setlist and not (song_id = any(p_order));

-- Snapshot the featured lead of each solo part, denormalizing the display fields so the record
-- survives later deletion of the part, song, or member.
insert into public.performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id,
sg.title, coalesce(p.label, 'Solo'), m.display_name
from public.part p
join public.song    sg on sg.id = p.song_id
join public.casting c  on c.part_id = p.id and c.is_primary
join public.member  m  on m.id = c.member_id
where p.ensemble_id = v_ensemble and p.is_solo and p.song_id = any(p_order)
on conflict (setlist_id, part_id) do nothing;

update public.setlist set status = 'performed', performed_date = v_date where id = p_setlist;

update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(p_order);

return true;
end;
$$;

revoke all on function perform_setlist(uuid, uuid[]) from public;
grant  execute on function perform_setlist(uuid, uuid[]) to authenticated;
