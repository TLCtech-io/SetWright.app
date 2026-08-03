-- Joining an ensemble becomes the invitee's decision.
--
-- Until now /auth/confirm called claim_membership() on every verified confirm, of any type, and that
-- function bound EVERY pending seat matching the address. Nobody asked the person named on the seat.
-- A director could record an invitation for any address they knew, send nothing, and the account was
-- bound the next time its owner clicked a magic link or reset their password, whatever they were
-- actually trying to do at the time. Migration 063 bounded how long that stayed possible; it did not
-- make it consensual.
--
-- Three functions replace the one. list_pending_invitations shows the invitee what is waiting,
-- accept_invitation binds a single named ensemble, decline_invitation refuses it. claim_membership is
-- dropped, so no "bind everything" path is left behind for a future caller to reach for.
--
-- A definer reader is not optional here. An invitee holds no member row yet, so member_read,
-- ensemble_read and member_invite_read all resolve to nothing for them: they cannot read the ensemble's
-- name, the seat that names them, or the invitation itself. Without this function the accept screen
-- would have nothing to render.
--
-- Every function keys on auth.email() rather than on an argument, so a caller can only ever see or act
-- on invitations addressed to their own GoTrue-confirmed address. The ensemble id argument narrows
-- that set; it cannot widen it.

alter table member_invite add column declined_at timestamptz;

comment on column member_invite.declined_at is
    'Set when the invitee refuses. The row stays so the roster can show the director it was declined, and nothing re-offers it.';

-- A declined invitation must not be resurrected by the unauthenticated resend path.
create or replace function refresh_pending_invite(p_email text)
returns boolean
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
with renewed as (
    update public.member_invite mi
    set invited_at = now()
    from public.ensemble e
    where e.id = mi.ensemble_id
    and e.status = 'active'
    and lower(mi.invite_email) = lower(p_email)
    and mi.first_invited_at > now() - interval '30 days'
    and mi.declined_at is null
    returning mi.member_id
)
select exists (select 1 from renewed);
$$;
revoke all on function refresh_pending_invite(text) from public;
grant  execute on function refresh_pending_invite(text) to service_role;

-- What the invitee may see. Same eligibility rules the bind enforces, so the screen never offers
-- something accept_invitation would then refuse.
create or replace function public.list_pending_invitations()
returns table (
    ensemble_id   uuid,
    ensemble_name text,
    seat_name     text,
    invited_at    timestamptz
)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
select mi.ensemble_id, e.name, m.display_name, mi.invited_at
from public.member_invite mi
join public.member m on m.ensemble_id = mi.ensemble_id and m.id = mi.member_id
join public.ensemble e on e.id = mi.ensemble_id
where auth.uid() is not null
and lower(nullif(auth.email(), '')) is not null
and lower(mi.invite_email) = lower(auth.email())
and mi.declined_at is null
and mi.invited_at > now() - interval '14 days'
and m.user_id is null
and e.status = 'active'
and exists (
    select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
)
and not exists (
    select 1 from public.member m2
    where m2.ensemble_id = mi.ensemble_id and m2.user_id = auth.uid()
)
order by mi.invited_at desc;
$$;
revoke all on function public.list_pending_invitations() from public;
grant  execute on function public.list_pending_invitations() to authenticated;

-- Bind ONE ensemble, named by the caller. Returns true when a seat was bound, false when there was
-- nothing eligible, which the route reports as a 409 rather than a silent success.
create or replace function public.accept_invitation(p_ensemble uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid   uuid := auth.uid();
v_email text := lower(nullif(auth.email(), ''));
v_bound uuid;
begin
if v_uid is null then
raise exception 'accept_invitation: not authenticated';
end if;
if v_email is null then
return false;
end if;
-- Bind only when the session's email is GoTrue-confirmed, independent of the hosted confirmation
-- setting, else a pre-registration on someone else's address could accept their invitation.
if not exists (
    select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null
) then
return false;
end if;

with claimable as (
    select mi.member_id, mi.ensemble_id
    from public.member_invite mi
    join public.member m on m.ensemble_id = mi.ensemble_id and m.id = mi.member_id
    where mi.ensemble_id = p_ensemble
    and m.user_id is null
    and lower(mi.invite_email) = v_email
    and mi.declined_at is null
    and mi.invited_at > now() - interval '14 days'
    and exists (select 1 from public.ensemble e where e.id = mi.ensemble_id and e.status = 'active')
    and not exists (
        select 1 from public.member m2
        where m2.ensemble_id = mi.ensemble_id and m2.user_id = v_uid
    )
),
bound as (
    update public.member m
    set user_id    = v_uid,
    updated_by = v_uid,
    updated_at = now()
    from claimable c
    where m.ensemble_id = c.ensemble_id and m.id = c.member_id
    returning m.ensemble_id, m.id
),
cleared as (
    delete from public.member_invite mi
    using bound b
    where mi.member_id = b.id
    returning mi.member_id
)
select bound.ensemble_id into v_bound from bound;

return v_bound is not null;
end;
$$;
revoke all on function public.accept_invitation(uuid) from public;
grant  execute on function public.accept_invitation(uuid) to authenticated;

-- Refusing keeps the row and stamps it, so the director sees the outcome on the roster instead of an
-- invitation that appears to be still waiting. The seat itself stays unclaimed and re-invitable.
create or replace function public.decline_invitation(p_ensemble uuid)
returns boolean
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
with refused as (
    update public.member_invite mi
    set declined_at = now()
    where mi.ensemble_id = p_ensemble
    and auth.uid() is not null
    and lower(nullif(auth.email(), '')) is not null
    and lower(mi.invite_email) = lower(auth.email())
    and mi.declined_at is null
    returning mi.member_id
)
select exists (select 1 from refused);
$$;
revoke all on function public.decline_invitation(uuid) from public;
grant  execute on function public.decline_invitation(uuid) to authenticated;

-- The bind-everything path goes. /auth/confirm no longer calls it, and leaving it granted to
-- authenticated would keep a one-call route to joining every ensemble that named the address.
drop function public.claim_membership();
