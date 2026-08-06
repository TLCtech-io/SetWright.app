-- Round-4 review corrections.
--
-- #3 (defense-in-depth): the per-seat invite BEARER token used to ride in the invitee's READABLE
-- user_metadata — the only conduit GoTrue's email template can read to build the claim link — so
-- claim_membership could hash-match it. Anyone able to read that metadata before the claim (a hosted
-- instance with email confirmation off, or a legacy auto-confirmed account on the victim's address)
-- could lift the token and claim the seat without ever opening the email. Bind on the GoTrue-VERIFIED
-- email instead: the invitee proves control of the address by completing the OTP, and claim_membership
-- matches member.invite_email to auth.email(). No bearer to leak, and the redirect-allow-list
-- workaround that forced the token into metadata is no longer needed. The invite_token_hash column
-- stays (populated by inviteMember) as a dormant, unconsulted second factor. The old
-- claim_membership(text) is dropped so nothing calls the token path.
--
-- L (lower): perform_setlist silently truncated an over-2048 order (p_order[1:2048]) and still
-- returned success, so a director calling PostgREST directly with a huge array got a partially-saved
-- performed set with no error. Raise instead of truncating, so the caller learns it was rejected.

drop function if exists public.claim_membership(text);

create or replace function public.claim_membership()
returns table (ensemble_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid   uuid := auth.uid();
v_email text := lower(nullif(auth.email(), ''));
begin
if v_uid is null then
raise exception 'claim_membership: not authenticated';
end if;
-- No verified email on the session => nothing to bind. A bind requires proven control of the
-- invited address (the OTP the invitee just completed), not a bearer token.
if v_email is null then
return;
end if;

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
    and m.invite_email is not null
    and lower(m.invite_email) = v_email
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
revoke all on function public.claim_membership() from public;
grant  execute on function public.claim_membership() to authenticated;

-- L: perform_setlist REJECTS an oversized order instead of silently truncating it. Otherwise
-- identical to migration 29 (row lock, safe-tz fallback, dedupe + 512 distinct cap, soloist snapshot).
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

update public.setlist set status = 'performed', performed_date = v_date where id = p_setlist;
update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(v_order);
return true;
end;
$$;
revoke all on function perform_setlist(uuid, uuid[]) from public;
grant  execute on function perform_setlist(uuid, uuid[]) to authenticated;
