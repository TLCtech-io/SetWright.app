-- Round-3 review corrections.
--
-- F2: two earlier fixes were (incorrectly) applied by EDITING already-released migrations — the
-- perform_setlist dedupe into migration 21 and the last-director user_id/ensemble_id guard into
-- migration 23. Editing an applied migration never reaches a database that already recorded it.
-- Those edits are reverted to the originals; the corrected functions are (re)created here so every
-- database converges regardless of which version it first applied.
-- F3: archived tenants were not fully frozen — auth_is_self ignored ensemble status (so direct
-- availability writes still passed RLS) and claim_membership accepted seats in archived ensembles.
-- F4: create_ensemble was deliberately dropped in migration 10 (it makes an unusable, vocabulary-
-- less tenant) but migration 26 resurrected it; drop it again.
-- F5: the founding quota counted then inserted without a lock, so concurrent calls all passed.

-- ----------------------------------------------------------------------------
-- F2: perform_setlist — deduped, length-bounded order (was edited into migration 21).
-- ----------------------------------------------------------------------------
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
v_order    uuid[];
begin
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

-- Dedupe (first occurrence), then cap, so a duplicate or oversized order (a direct PostgREST call
-- bypasses the route cap) can neither bump a song to a stale position nor freeze a malformed
-- record. Positions are then a contiguous 1..N. Songs outside this ensemble fail the FK and abort.
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

update public.setlist set status = 'performed', performed_date = v_date where id = p_setlist;
update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(v_order);
return true;
end;
$$;
revoke all on function perform_setlist(uuid, uuid[]) from public;
grant  execute on function perform_setlist(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- F2: guard_last_director — also blocks unbinding user_id or moving the seat to another ensemble
-- (was edited into migration 23). The member_last_director_guard trigger from migration 23 still
-- references this function by name, so recreating the function is enough.
-- ----------------------------------------------------------------------------
create or replace function guard_last_director()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid := old.ensemble_id;
begin
if old.permission_tier = 'director' and old.status = 'active' and old.user_id is not null
and (tg_op = 'DELETE' or new.permission_tier <> 'director' or new.status <> 'active'
    or new.user_id is null or new.ensemble_id is distinct from old.ensemble_id)
and not exists (
    select 1 from public.member m
    where m.ensemble_id = v_ensemble
    and m.permission_tier = 'director'
    and m.status = 'active'
    and m.user_id is not null
    and m.id <> old.id
    for update
) then
raise exception 'an ensemble must keep at least one active director';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ----------------------------------------------------------------------------
-- F3a: auth_is_self also requires the member's ensemble to be active, so an archived tenant freezes
-- the self-WRITE RLS paths (availability_write etc.), not just the self RPCs. Self-READ uses
-- member_read's own `user_id = auth.uid()` branch (not this), so a member can still see their row.
-- ----------------------------------------------------------------------------
create or replace function auth_is_self(p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select exists (
    select 1 from public.member m
    join public.ensemble e on e.id = m.ensemble_id and e.status = 'active'
    where m.id = p_member and m.user_id = auth.uid()
    and m.status = 'active'
);
$$;

-- ----------------------------------------------------------------------------
-- F3b: claim_membership refuses a seat whose ensemble is not active.
-- ----------------------------------------------------------------------------
create or replace function public.claim_membership(p_token text)
returns table (ensemble_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid  uuid := auth.uid();
v_hash text;
begin
if v_uid is null then
raise exception 'claim_membership: not authenticated';
end if;
if p_token is null or length(p_token) < 16 then
return;
end if;
v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

return query
with bound as (
    update public.member m
    set user_id          = v_uid,
    invite_email      = null,
    invite_token_hash = null,
    invited_at        = null,
    updated_by        = v_uid,
    updated_at        = now()
    where m.user_id is null
    and m.invite_token_hash is not null
    and m.invite_token_hash = v_hash
    and m.invited_at > now() - interval '14 days'
    and exists (select 1 from public.ensemble e where e.id = m.ensemble_id and e.status = 'active')
    and not exists (
        select 1 from public.member m2
        where m2.ensemble_id = m.ensemble_id and m2.user_id = v_uid
    )
    returning m.ensemble_id
)
select bound.ensemble_id from bound;
end;
$$;
revoke all on function public.claim_membership(text) from public;
grant  execute on function public.claim_membership(text) to authenticated;

-- ----------------------------------------------------------------------------
-- F4: create_ensemble was dropped in migration 10 (unusable vocabulary-less tenant); migration 26
-- wrongly recreated it. Drop it again so the only founding path is create_ensemble_seeded.
-- ----------------------------------------------------------------------------
drop function if exists public.create_ensemble(text, text);

-- ----------------------------------------------------------------------------
-- F5: race-free founding quota. A per-user transaction advisory lock serializes the count + insert,
-- so concurrent calls can't all pass the limit (a live probe created 28 ensembles against a cap of
-- 20). create_ensemble_seeded is otherwise unchanged from migration 26 (which keeps the quota).
-- ----------------------------------------------------------------------------
create or replace function create_ensemble_seeded(p_name text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid        uuid := auth.uid();
v_ensemble   uuid;
v_pp_concert uuid;
v_pp_service uuid;
begin
if v_uid is null then
raise exception 'create_ensemble_seeded: not authenticated';
end if;
-- Serialize this account's founding so the count + insert below are atomic w.r.t. the quota.
perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
if (select count(*) from public.member m
    where m.user_id = v_uid and m.permission_tier = 'director' and m.status = 'active') >= 20 then
raise exception 'create_ensemble_seeded: you already direct the maximum number of ensembles';
end if;

insert into public.ensemble (name, created_by, updated_by)
values (p_name, v_uid, v_uid)
returning id into v_ensemble;

insert into public.member (ensemble_id, user_id, display_name, permission_tier, status, created_by, updated_by)
values (v_ensemble, v_uid, coalesce(p_display_name, 'Director'), 'director', 'active', v_uid, v_uid);

insert into public.voice_part (ensemble_id, label, sort_order, is_pitched) values
(v_ensemble, 'Soprano',          0, true),
(v_ensemble, 'Alto',             1, true),
(v_ensemble, 'Tenor',            2, true),
(v_ensemble, 'Bass',             3, true),
(v_ensemble, 'Vocal Percussion', 4, false);

insert into public.tag (ensemble_id, name, category, sort_order) values
(v_ensemble, 'uptempo', 'groove',   0),
(v_ensemble, 'ballad',  'mood',     1),
(v_ensemble, 'gospel',  'genre',    2),
(v_ensemble, 'holiday', 'occasion', 3);

insert into public.padding_profile (ensemble_id, name, per_song_seconds, per_set_seconds)
values (v_ensemble, 'Concert', 30, 90) returning id into v_pp_concert;
insert into public.padding_profile (ensemble_id, name, per_song_seconds, per_set_seconds)
values (v_ensemble, 'Church service', 20, 180) returning id into v_pp_service;

insert into public.event_type (ensemble_id, name, sort_order, padding_profile_id, default_allows_on_book, default_allows_explicit) values
(v_ensemble, 'Concert', 0, v_pp_concert, true,  false),
(v_ensemble, 'Service', 1, v_pp_service, true,  false);

return v_ensemble;
end;
$$;
revoke all on function create_ensemble_seeded(text, text) from public;
grant  execute on function create_ensemble_seeded(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Assign a playground program to an event as a fresh draft setlist, atomically. The adapter created
-- the setlist and then set its pins in two separate requests, so a failure left a pin-less setlist
-- stranded on the event. One transaction: create the draft and copy the program's order as
-- open/close/keep pins. Returns the new setlist id, or null when the program/event is not visible.
-- ----------------------------------------------------------------------------
create or replace function create_setlist_from_program(p_ensemble uuid, p_program uuid, p_event uuid)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_name  text;
v_new   uuid;
v_open  uuid;
v_close uuid;
begin
select name into v_name from public.program where ensemble_id = p_ensemble and id = p_program;
if v_name is null then return null; end if;
if not exists (select 1 from public.event where ensemble_id = p_ensemble and id = p_event) then
return null;
end if;

select song_id into v_open  from public.program_item
where ensemble_id = p_ensemble and program_id = p_program and pin = 'open'  limit 1;
select song_id into v_close from public.program_item
where ensemble_id = p_ensemble and program_id = p_program and pin = 'close' limit 1;
if v_close is not distinct from v_open then v_close := null; end if;

insert into public.setlist (ensemble_id, event_id, program_id, name, status)
values (p_ensemble, p_event, p_program, v_name, 'draft')
returning id into v_new;

insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, position)
select p_ensemble, v_new, pi.song_id,
case when pi.song_id = v_open then 'open' when pi.song_id = v_close then 'close' else 'keep' end,
false, 0
from public.program_item pi
where pi.ensemble_id = p_ensemble and pi.program_id = p_program;
return v_new;
end;
$$;
revoke all on function create_setlist_from_program(uuid, uuid, uuid) from public;
grant  execute on function create_setlist_from_program(uuid, uuid, uuid) to authenticated;
