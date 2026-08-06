-- Fix bug #3: the performed_snapshot write must be atomic with the perform, INSIDE perform_setlist.
-- The first attempt (a second UPDATE from the adapter, after perform_setlist) is blocked by
-- setlist_immutable_guard (migrations 15/21), which raises on ANY update to an already-performed
-- setlist row — so performed_snapshot was never written and getPerformedSet always fell back to live,
-- leaving bug #3 unfixed in production while the guard-free mock froze correctly.
--
-- Recreate perform_setlist with a p_snapshot jsonb param folded into the status-flip UPDATE. At that
-- statement old.status is still 'draft' and the txn-local perform-writer flag vouches, so the guard
-- passes (exactly as the status/performed_date write already does). The app builds the snapshot from
-- the same order perform freezes (deduped, capped) so snap.songs aligns with setlist_item. Drop the
-- 2-arg version so the 3-arg signature is unambiguous. Otherwise identical to migration 030.

drop function if exists perform_setlist(uuid, uuid[]);

create or replace function perform_setlist(p_setlist uuid, p_order uuid[], p_snapshot jsonb)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_date     date;
v_order    uuid[];
begin
perform set_config('app.perform_writer', 'rpc', true);
-- Reject rather than silently truncate: a caller sending more than the bound learns the order was
-- refused instead of receiving a success for a partially-saved set.
if array_length(p_order, 1) > 2048 then
raise exception 'perform_setlist: order too large (% items); max 2048', array_length(p_order, 1)
using errcode = '22023';
end if;

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

v_order := (
    select array_agg(song_id order by first_ord)
    from (
        select song_id, min(ord) as first_ord
        from unnest(p_order) with ordinality as u(song_id, ord)
        group by song_id
    ) d
);
v_order := v_order[1:512];

insert into public.setlist_item (ensemble_id, setlist_id, song_id, position, is_excluded, pin)
select v_ensemble, p_setlist, s.song_id, s.rn::int, false, null
from unnest(v_order) with ordinality as s(song_id, rn)
on conflict (setlist_id, song_id)
do update set position = excluded.position, is_excluded = false, pin = null;

delete from public.setlist_item
where setlist_id = p_setlist and not (song_id = any(v_order));

insert into public.performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id,
sg.title, coalesce(p.label, 'Solo'), m.display_name
from public.part p
join public.song    sg on sg.id = p.song_id
join public.casting c  on c.part_id = p.id and c.is_primary
join public.member  m  on m.id = c.member_id
where p.ensemble_id = v_ensemble and p.is_solo and p.song_id = any(v_order)
on conflict (setlist_id, part_id) do nothing;

-- Freeze status + date + the song/event snapshot in one UPDATE while the row is still 'draft', so
-- setlist_immutable_guard vouches for it. p_snapshot may be null (an older client); reads then fall
-- back to live, so a null is safe.
update public.setlist
set status = 'performed', performed_date = v_date, performed_snapshot = p_snapshot
where id = p_setlist;
update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(v_order);
return true;
end;
$$;
revoke all on function perform_setlist(uuid, uuid[], jsonb) from public;
grant  execute on function perform_setlist(uuid, uuid[], jsonb) to authenticated;
