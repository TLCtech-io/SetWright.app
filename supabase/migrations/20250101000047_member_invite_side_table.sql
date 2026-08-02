-- Codex bug #1 / sec #2: member_read lets ANY active member SELECT the whole member row, which
-- carries invite_email / invited_at / invite_token_hash, so a plain member can read a peer's pending
-- invite address directly via the Data API (RLS is row-level; app-layer masking does not stop a raw
-- PostgREST query). Within-tenant, but real.
--
-- Move the invite state into a director-only side table so a member cannot read it at all. RLS is now
-- the enforcement, not the app projection. claim_membership (SECURITY DEFINER) still binds via the
-- invite, reading it through the definer bypass. Recreated BEFORE the column drop so no live function
-- references the dropped columns. Keeps the confirmed-email guard added in 043.

-- Director-only pending-invite state. One row per unclaimed seat; deleted when the seat is claimed.
create table member_invite (
    ensemble_id       uuid not null,
    member_id         uuid not null primary key,
    invite_email      text not null,
    invited_at        timestamptz not null default now(),
    invite_token_hash text,
    foreign key (ensemble_id, member_id) references member(ensemble_id, id) on delete cascade
);
-- At most one pending seat per email per ensemble (the backstop the app pre-checks for a friendly
-- message). Every row here is pending by construction (claim deletes it), so no partial predicate is
-- needed, unlike the old index on member which had to exclude claimed rows.
create unique index member_invite_one_per_email on member_invite (ensemble_id, lower(invite_email));

alter table member_invite enable row level security;
grant select, insert, update, delete on member_invite to authenticated;
-- Director-only read AND write: the invite email/token never reach a plain member.
create policy member_invite_read on member_invite
for select using (auth_member_tier(ensemble_id) = 'director');
create policy member_invite_write on member_invite
for all using (auth_member_tier(ensemble_id) = 'director')
with check (auth_member_tier(ensemble_id) = 'director');

-- Move existing pending invites off member. Match member_one_pending_invite's own predicate
-- (invite_email set AND unclaimed) so a stray invite_email on a claimed row can't ride along and
-- collide on the new unique index — self-defending rather than trusting the app-enforced invariant.
insert into member_invite (ensemble_id, member_id, invite_email, invited_at, invite_token_hash)
select ensemble_id, id, invite_email, coalesce(invited_at, now()), invite_token_hash
from member
where invite_email is not null and user_id is null;

-- claim_membership binds via member_invite now. It reads the invite (definer bypasses member_invite
-- RLS), binds the member, and deletes the invite row. Otherwise identical to 043 (confirmed-email
-- guard, 14-day window, active-ensemble check, one-seat guard).
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
if v_email is null then
return;
end if;
-- Defense in depth: bind only when the session's email is GoTrue-confirmed (independent of the
-- hosted confirmation setting), else a pre-registration on a victim's address could claim their seat.
if not exists (
    select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null
) then
return;
end if;

return query
with claimable as (
    select mi.member_id, mi.ensemble_id
    from public.member_invite mi
    join public.member m on m.ensemble_id = mi.ensemble_id and m.id = mi.member_id
    where m.user_id is null
    and lower(mi.invite_email) = v_email
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
select bound.ensemble_id from bound;
end;
$$;
revoke all on function public.claim_membership() from public;
grant  execute on function public.claim_membership() to authenticated;

-- Drop the columns off member now that nothing live references them (the member_one_pending_invite
-- index drops automatically with invite_email).
alter table member
drop column invite_email,
drop column invited_at,
drop column invite_token_hash;
