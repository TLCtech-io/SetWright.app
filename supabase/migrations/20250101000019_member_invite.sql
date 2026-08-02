-- ============================================================================
-- Workstream C: the email-invite "claim your seat" flow.
--
-- A director invites a member by email; the invitee accepts a Supabase auth email
-- (invite for a brand-new account, magic link for one that already exists) and, on
-- first sign-in, the app BINDS their account to the waiting seat. Until then the seat
-- is "pending": user_id null, invite_email set. This migration adds the seat's invite
-- address and the bind RPC.
--
-- The mechanism is the one rls.sql already sketched (lines ~21-27): the verified auth
-- email IS the claim token — no custom token table. claim_membership() matches the
-- caller's CONFIRMED email against pending seats and stamps user_id. Delivery rides
-- Supabase auth (inviteUserByEmail / generateLink); the production email body is
-- rendered by the Send Email Hook edge function (Resend), local dev uses Mailpit.
-- ============================================================================

-- The address a pending seat was invited under. Director-readable (the member_read
-- policy already covers it), for resend + roster display + matching the claimer's
-- verified email. Cleared on claim: once a seat is bound, app_user.email is the
-- canonical address (the same "convenience mirror; auth is canonical" rule app_user
-- follows). invited_at drives the roster's "pending / invited" indicator + resend UX.
alter table member add column invite_email text;
alter table member add column invited_at   timestamptz;

-- At most one PENDING seat per email per ensemble, so a claim binds an unambiguous
-- seat. Active members are naturally excluded (user_id is not null once claimed), and
-- two different people can still be invited under different addresses.
create unique index member_one_pending_invite
on member (ensemble_id, lower(invite_email))
where user_id is null and invite_email is not null;

-- Bind every unclaimed seat invited under the caller's *confirmed* email to the caller.
--
-- SECURITY DEFINER so it can update member rows a non-director may not write
-- (member_write is director-only). This is safe because it only ever binds seats whose
-- invite_email equals the caller's OWN verified auth email, and only in ensembles where
-- the caller does not already hold a membership (preserving unique (ensemble_id,
-- user_id)). An UNCONFIRMED email claims nothing — otherwise an unverified signup using
-- someone else's address could hijack their invite. Idempotent: re-running after a claim
-- (e.g. on every sign-in) is a no-op. Returns the ensembles newly bound so the caller
-- can route the user into one.
create or replace function claim_membership()
returns table (ensemble_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid   uuid := auth.uid();
v_email text;
begin
if v_uid is null then
raise exception 'claim_membership: not authenticated';
end if;

-- The caller's canonical, confirmed email straight from GoTrue's source of truth.
select u.email into v_email
from auth.users u
where u.id = v_uid and u.email_confirmed_at is not null;
if v_email is null then
return;  -- no confirmed email: nothing to claim
end if;

return query
with bound as (
    update public.member m
    set user_id      = v_uid,
    invite_email = null,
    invited_at   = null,
    updated_by   = v_uid,
    updated_at   = now()
    where m.user_id is null
    and m.invite_email is not null
    and lower(m.invite_email) = lower(v_email)
    and not exists (
        select 1 from public.member m2
        where m2.ensemble_id = m.ensemble_id and m2.user_id = v_uid
    )
    returning m.ensemble_id
)
select bound.ensemble_id from bound;
end;
$$;

revoke all on function claim_membership() from public;
grant  execute on function claim_membership() to authenticated;
