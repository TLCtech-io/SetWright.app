-- Codex security #1 (defense in depth): claim_membership() binds a pending seat on the GoTrue email
-- claim (auth.email()) but does not independently verify the address is CONFIRMED. Today the hosted
-- config has email confirmation on, so a session's auth.email() is already the verified address —
-- but that invariant lives entirely in the dashboard/config, not in the function. Migration 019 had
-- an explicit email_confirmed_at check; migration 030 dropped it when it moved to email binding.
--
-- Re-add the check so the function no longer depends on the dashboard setting: if confirmations ever
-- drift off, an attacker who pre-registers a victim's address gets a session whose auth.email() is
-- that address — this refuses to bind the victim's pending seat to an unconfirmed account. Otherwise
-- identical to migration 030 (SECURITY DEFINER, email binding, 14-day window, one-seat guard).

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
-- Defense in depth: bind only when the session's email is GoTrue-confirmed, independent of the
-- hosted email-confirmation setting. Without this, an unconfirmed pre-registration on a victim's
-- address could claim their pending seat if that setting ever drifted off.
if not exists (
    select 1 from auth.users u
    where u.id = v_uid and u.email_confirmed_at is not null
) then
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
