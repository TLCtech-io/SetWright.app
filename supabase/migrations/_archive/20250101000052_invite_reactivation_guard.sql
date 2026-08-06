-- Invite lifecycle hardening.
--
-- Two changes, both aimed at the same dead end: an invite that can never bind because the invited
-- person already holds a seat in the ensemble (claim_membership refuses a second seat per user — see
-- 047). Before this, a director could invite such an address and the invite would pend forever with
-- no feedback, and archiving a pending seat left its invite claimable onto an inactive row.
--
-- 1. set_member_status revokes a seat's pending invite when the seat is deactivated. A removed seat
--    should not keep a claimable invite; reactivation (status -> active) is the path back and needs
--    no stale invite. Otherwise identical to the 027 definition (prune coverage on deactivate).
-- 2. ensemble_seat_for_email lets the invite flow detect, up front, that the invited email already
--    belongs to a claimed seat here (active or archived), so it can steer the director to reactivate
--    that seat instead of recording a dead-end invite.

create or replace function set_member_status(p_ensemble uuid, p_member uuid, p_status text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
update public.member set status = p_status where ensemble_id = p_ensemble and id = p_member;
if not found then return false; end if;
if p_status = 'inactive' then
perform public.prune_member_coverage(p_ensemble, p_member);
-- Revoke any pending invite for the deactivated seat: a "removed" seat must not keep a claimable
-- invite that would bind the invitee onto an inactive row (auth_member_tier requires active, so
-- they would land with no access). Runs as the caller (invoker); the director's member_invite_write
-- policy authorizes the delete.
delete from public.member_invite where ensemble_id = p_ensemble and member_id = p_member;
end if;
return true;
end;
$$;
revoke all on function set_member_status(uuid, uuid, text) from public;
grant  execute on function set_member_status(uuid, uuid, text) to authenticated;

-- Director-only lookup: does this email's account already hold a seat in this ensemble, and is it
-- active or archived? SECURITY DEFINER to read auth.users (the email -> user_id map a plain query
-- cannot reach), gated to a director OF THIS ensemble via auth_member_tier, so it reveals only a
-- within-ensemble roster fact the caller already has (a member's seat + status), never a cross-tenant
-- fact and never the email of anyone the caller did not just type. Returns at most one row; empty for
-- a non-director caller or an email with no claimed seat here.
create or replace function public.ensemble_seat_for_email(p_ensemble uuid, p_email text)
returns table (member_id uuid, member_status text, display_name text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select m.id, m.status, m.display_name
from public.member m
join auth.users u on u.id = m.user_id
where m.ensemble_id = p_ensemble
and public.auth_member_tier(p_ensemble) = 'director'
and lower(u.email) = lower(p_email)
limit 1;
$$;
revoke all on function public.ensemble_seat_for_email(uuid, text) from public;
grant  execute on function public.ensemble_seat_for_email(uuid, text) to authenticated;
