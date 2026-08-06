-- Track 2 (invite-first front door), phase A: an application-level rate limit for the invite surfaces
-- (director invite, member invite, and the unauthenticated resend).
--
-- In-memory limiting does not hold on Vercel Fluid Compute (per-instance, resets on cold start), so
-- this is a Postgres-backed counter behind a SECURITY DEFINER check, reusing the definer pattern used
-- across the schema. The table is deny-all: RLS on, no policies, and no grants to authenticated/anon,
-- so PostgREST cannot touch it. Only the definer functions below (owned by the definer, bypassing RLS)
-- read or write it.
--
-- The ceiling for each kind is SERVER-DEFINED, not a function argument. A client-supplied window/limit
-- would let an authenticated caller pass a tiny window (count ~0) or a huge limit and reset or widen
-- its own bucket, defeating the ceiling it is constrained by. So the wrappers take only the kind; the
-- engine resolves the limit + window itself and fails closed on an unknown kind.

create table invite_rate_event (
    id         bigint generated always as identity primary key,
    subject    text not null,   -- the rate key: an actor's auth.uid()::text, or a normalized email
    kind       text not null,   -- 'director_invite' | 'member_invite' | 'resend'
    created_at timestamptz not null default now()
);
create index invite_rate_event_lookup on invite_rate_event (subject, kind, created_at);
-- Supports the opportunistic global GC in consume_kind (a delete keyed only on created_at).
create index invite_rate_event_created on invite_rate_event (created_at);

alter table invite_rate_event enable row level security;
-- Deny-all: no policies and no grants. The definer functions are the only access path.
revoke all on invite_rate_event from authenticated, anon;

-- The engine. Resolves the server-defined ceiling for p_kind (unknown kind fails closed), takes a
-- transaction advisory lock to serialize same key + kind callers (so the count-then-insert cannot be
-- raced past the limit, the whole point for the unauthenticated resend), prunes this key's own expired
-- rows, counts what remains in the window, and allows-and-inserts only when under the limit. Internal:
-- not granted to any client role, called only by the two wrappers below (which run as the definer owner).
create or replace function consume_kind(p_subject text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_key    text := nullif(p_subject, '');
v_window interval := interval '1 hour';
v_limit  int;
v_count  int;
begin
if v_key is null then
return false;
end if;
-- Server-authoritative ceilings (per hour). The client never supplies these.
v_limit := case p_kind
when 'director_invite' then 20
when 'member_invite'   then 30
when 'resend'          then 3
else 0
end;
if v_limit <= 0 then
return false;  -- unknown kind: no allowance
end if;
-- Opportunistically GC expired rows across ALL subjects (~1% of calls). The per-subject prune below
-- keeps this key's count correct, but the unauthenticated, email-keyed resend has an attacker-chosen,
-- unbounded subject, so without a global sweep a spray of distinct addresses would grow the table without
-- bound. Amortized and cheap (created_at index); only ever deletes rows already outside every window.
if random() < 0.01 then
delete from public.invite_rate_event where created_at <= now() - interval '1 hour';
end if;
perform pg_advisory_xact_lock(hashtext('invite_rate:' || p_kind), hashtext(v_key));
delete from public.invite_rate_event
where subject = v_key and kind = p_kind and created_at <= now() - v_window;
select count(*) into v_count
from public.invite_rate_event
where subject = v_key and kind = p_kind and created_at > now() - v_window;
if v_count >= v_limit then
return false;
end if;
insert into public.invite_rate_event (subject, kind) values (v_key, p_kind);
return true;
end;
$$;
revoke all on function consume_kind(text, text) from public;

-- Authenticated-actor wrapper, keyed on auth.uid(). The director-invite and member-invite routes call
-- this via the user's client. The kind is the only input; the ceiling is fixed above.
create or replace function consume_invite_quota(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid uuid := auth.uid();
begin
if v_uid is null then
return false;
end if;
return public.consume_kind(v_uid::text, p_kind);
end;
$$;
revoke all on function consume_invite_quota(text) from public;
grant  execute on function consume_invite_quota(text) to authenticated;

-- Email-keyed wrapper for the UNAUTHENTICATED resend route (auth.uid() is null there), keyed on the
-- normalized email so one address cannot be used to spam a victim's inbox. Granted to service_role
-- only: the resend route holds a service-role client, and keeping this off anon means a client cannot
-- burn a victim's resend quota by calling the RPC directly.
create or replace function consume_invite_quota_by_email(p_email text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
return public.consume_kind(lower(nullif(trim(p_email), '')), p_kind);
end;
$$;
revoke all on function consume_invite_quota_by_email(text, text) from public;
grant  execute on function consume_invite_quota_by_email(text, text) to service_role;

-- Renew and report a PENDING member invitation for this email. The unauthenticated self-serve resend calls
-- it so it re-sends ONLY to an address that actually has a waiting invite -- never an open relay to
-- arbitrary inboxes. Invite state lives in the member_invite side table (migration 047), and a row there
-- exists ONLY while a seat is pending (deleted on claim + on seat removal), so a row for this email is the
-- pending signal. For every ACTIVE-ensemble pending seat under the address it bumps invited_at to now, so a
-- seat that had aged past claim_membership's 14-day bind window can bind again on accept -- matching the
-- director resend, which also refreshes invited_at. Archived/suspended ensembles are skipped, since
-- claim_membership refuses them (a resend there would be a dead-end email). SECURITY DEFINER to touch the
-- director-only side table across ensembles despite RLS; service_role ONLY, so it is not an enumeration
-- oracle for any client -- the resend route calls it server-side and never reveals the boolean.
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
    returning mi.member_id
)
select exists (select 1 from renewed);
$$;
revoke all on function refresh_pending_invite(text) from public;
grant  execute on function refresh_pending_invite(text) to service_role;
