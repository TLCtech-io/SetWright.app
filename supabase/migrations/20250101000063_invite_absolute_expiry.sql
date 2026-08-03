-- Stop the unauthenticated resend path from extending an invite forever.
--
-- claim_membership binds a seat only while mi.invited_at is inside 14 days (047:76). That window is
-- what limits how long an unaccepted invite stays bindable, which matters because the director who
-- created it needed no consent from the address it names: the victim is bound at their next auth
-- confirm, whatever they were actually doing at the time.
--
-- refresh_pending_invite sets invited_at = now() and is reachable from POST /api/auth/resend, which
-- is unauthenticated. The rate limit is 3 an hour per address, so roughly one request a fortnight
-- from anyone who knows the address keeps the seat bindable indefinitely and the 14-day expiry never
-- arrives. The renewal is the feature working as intended; the absence of any ceiling on it is not.
--
-- first_invited_at is the anchor the resend path cannot move. It is set once when the row is created
-- and never written again: refresh_pending_invite does not touch it, and the director's upsert
-- (repository.ts, on conflict member_id) does not carry the column, so an existing row keeps its
-- original value. The row itself is deleted on claim (047:93) and when a seat changes status
-- (052:30), so a genuinely new invitation gets a new row and a fresh anchor.
--
-- 30 days is the ceiling on self-serve renewal. It is a little over twice the link lifetime, which
-- covers the case the route exists for, an invitee coming back for a link that expired while they
-- were not looking. Past that, "the invitee is still trying to accept" stops being the likely
-- reading, and the right remedy is the director re-inviting, which is authenticated and deliberate.
-- A director is unaffected by this cap either way: their invite writes invited_at through RLS and
-- does not go through this function. Widening it is a one-word edit here.
--
-- Worst-case exposure goes from unbounded to 30 days of renewal plus the final 14-day window.

alter table member_invite add column first_invited_at timestamptz not null default now();

-- Existing rows: invited_at is the best anchor available. It may already have been carried forward
-- by resends, so this is generous to rows that exist today rather than retroactively expiring them.
update member_invite set first_invited_at = invited_at;

comment on column member_invite.first_invited_at is
    'When this invitation was first recorded. Never updated; refresh_pending_invite caps self-serve renewal against it.';

-- Redeclared from 056:128. Only the first_invited_at condition is new; CREATE OR REPLACE resets the
-- configuration, so the search_path pin is repeated here.
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
    returning mi.member_id
)
select exists (select 1 from renewed);
$$;
revoke all on function refresh_pending_invite(text) from public;
grant  execute on function refresh_pending_invite(text) to service_role;
