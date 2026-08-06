-- Provisioning, invites, founding credits, and the platform-admin surface.
--
-- Five groups, in dependency order:
--   1. gen_public_id, the URL token generator.
--   2. invite rate limiting: the engine and its two wrappers.
--   3. founding credits: grant, consume, and the only surviving ensemble founder.
--   4. director-side invite helpers.
--   5. invitee-side invitation handling, plus the unauthenticated resend renewal.
--
-- Ordering notes. gen_public_id belongs to this file by subject but is declared in 001, and only
-- there. Six tables in 001 take `default public.gen_public_id()`, and a default expression is
-- parsed at add-column time, so the function has to exist before the first of them. This file
-- keeps a note where the declaration would otherwise sit, and nothing more.
--
-- Everything else here depends only on lower-numbered files: auth_member_tier and
-- auth_is_platform_admin come from 002, prune_member_coverage from 005, and the tables
-- (app_user.founding_credits, member_invite, invite_rate_event) from 001.
--
-- Function bodies and the comments inside them are transcribed from the archive migration that
-- declared each one last, so the catalog carries the same rationale a reader would find in git.

-- ----------------------------------------------------------------------------
-- URL tokens
-- ----------------------------------------------------------------------------

-- Base64url of 16 random bytes with padding stripped, so exactly 22 chars (^[A-Za-z0-9_-]{22}$).
-- The bytes come from gen_random_uuid(), built in on PG13+, so this needs no extension. That is 122
-- bits of entropy: unguessable and collision free at any real scale. RLS still draws tenancy, so the
-- token is an identifier, not a secret. The matching app-layer validator and generator live in
-- apps/web/lib/publicId.ts.
--
-- Volatile on purpose. `add column` with a volatile default evaluates it once per existing row, so a
-- backfill gives every row a distinct token. A non-volatile default would reuse a single value and
-- the unique indexes in 001 would fail.
--
-- No revoke/grant pair: execute stays with public, matching the live ACL. A token generator leaks
-- nothing, and every insert path reaches it through a column default anyway.
--
-- It is declared in 001, not here, and this note is all that remains of it in this file. Six
-- public_id columns take it as their default, and a default expression is parsed when the column is
-- added, so the function has to exist before the first table. Declaring it in both places would be
-- harmless at apply time and still wrong: one object, one source of truth.

-- ----------------------------------------------------------------------------
-- Invite rate limiting
-- ----------------------------------------------------------------------------
--
-- In-memory limiting does not hold on Vercel Fluid Compute (per instance, resets on cold start), so
-- the counter lives in Postgres behind a definer check. invite_rate_event is deny-all: RLS on, no
-- policies, no grants, so PostgREST cannot touch it and these functions are the only access path.
--
-- The ceiling for each kind is server defined, never an argument. A client-supplied window or limit
-- would let a caller pass a tiny window (count ~0) or a huge limit and widen its own bucket. So the
-- wrappers take only the kind, the engine resolves the limit and window itself, and an unknown kind
-- fails closed.

-- The engine. Sweeps expired rows, serializes same key and kind callers on an advisory lock so the
-- count-then-insert cannot be raced past the limit, then allows and inserts only when under it.
-- Internal: granted to no client role, called only by the two wrappers below, which run as the
-- definer owner and so reach it regardless.
create or replace function public.consume_kind(p_subject text, p_kind text)
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
-- Collect a fixed slice of expired rows across ALL subjects, oldest first. The array form is
-- deliberate: it plans as a locked index scan on the created_at index feeding a bitmap probe on the
-- primary key, where the equivalent delete ... using seq-scans the outer side, which is the wrong
-- shape on exactly the backlog this exists to drain. skip locked means concurrent callers take
-- disjoint slices instead of queueing, and the whole thing runs before the advisory lock below so
-- it never holds row locks while waiting on one.
delete from public.invite_rate_event
where id = any (array(
    select e.id from public.invite_rate_event e
    where e.created_at <= now() - interval '1 hour'
    order by e.created_at
    limit 50
    for update skip locked
));
perform pg_advisory_xact_lock(hashtext('invite_rate:' || p_kind), hashtext(v_key));
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
revoke all on function public.consume_kind(text, text) from public;

-- Authenticated-actor wrapper, keyed on auth.uid(). The director-invite and member-invite routes call
-- this through the user's own client. The kind is the only input; the ceiling is fixed above.
create or replace function public.consume_invite_quota(p_kind text)
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
revoke all on function public.consume_invite_quota(text) from public;
grant  execute on function public.consume_invite_quota(text) to authenticated;

-- THE SERVICE_ROLE RULE. This function and refresh_pending_invite below are the only two functions
-- in the schema granted to service_role, and they exist for one caller: the unauthenticated resend
-- route, where auth.uid() is null so no authenticated path is available.
--
-- Read the split of duties carefully before adding a third. SECURITY DEFINER is what bypasses RLS.
-- The service-role key only gates who may call. So the safety of the pair does not come from the
-- key; it comes from the shape of the statement underneath it.
--
-- Both take the target email as a scalar, which means a caller does pick which row the elevated
-- statement touches. What a caller cannot do is widen the predicate: the shape is fixed in SQL,
-- neither accepts a filter expression, and neither returns another tenant's data. That is what
-- bounds the blast radius to a single address. Any third service_role grant must meet the same
-- terms: a fixed predicate, scalar arguments only, and a return value that says nothing beyond the
-- one address the caller named. Keeping them off anon matters too, or a client could burn a
-- victim's quota, or use the boolean as an enumeration oracle, by calling the RPC directly.
--
-- Email-keyed wrapper for the resend route, keyed on the normalized address so one address cannot be
-- used to spam a victim's inbox.
create or replace function public.consume_invite_quota_by_email(p_email text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
return public.consume_kind(lower(nullif(trim(p_email), '')), p_kind);
end;
$$;
revoke all on function public.consume_invite_quota_by_email(text, text) from public;
grant  execute on function public.consume_invite_quota_by_email(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Founding credits and ensemble creation
-- ----------------------------------------------------------------------------
--
-- Founding an ensemble is gated on a per-user credit, because create_ensemble_seeded is directly
-- callable through PostgREST and closing the UI would not close the door. app_user.founding_credits
-- defaults to 0, only a platform admin grants one, and create_ensemble_seeded consumes it
-- atomically. A plain member has none and is refused. The 20-owned quota stays as a backstop.
--
-- create_ensemble, the bare vocabulary-less founder, was dropped and stays dropped. Only the seeded
-- founder survives, so only it needs gating.

-- A platform admin authorizes one founding for a user. SECURITY DEFINER so it can write app_user,
-- which authenticated cannot (the admin flag and credit column are outside authenticated's column
-- grant), gated internally on the caller being a platform admin. The admin invite route calls this
-- through the admin's own authenticated client.
create or replace function public.grant_founding_credit(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
if not public.auth_is_platform_admin() then
raise exception 'grant_founding_credit: not a platform admin';
end if;
-- Idempotent: ensure the invited director holds exactly one UNSPENT founding credit; do not stack.
-- Granting only when they currently have none means a re-sent invite (they have not accepted yet, so
-- still hold their credit) is a no-op instead of a second credit -- which would let them found a second
-- ensemble for free. inviteUserByEmail re-invites an unconfirmed account by returning the SAME user, so
-- without this the invite route would grant twice. A genuinely new authorization still works: accepting
-- consumes the credit back to zero, so the next invite grants again. The `where ... = 0` predicate is
-- also concurrency-safe (row lock + re-check), and it makes the invite route retry-safe -- a re-POST
-- after a lost response or a failed grant re-sends and finishes authorizing without over-granting.
update public.app_user set founding_credits = 1
where id = p_user_id and founding_credits = 0;
if not found and not exists (select 1 from public.app_user where id = p_user_id) then
raise exception 'grant_founding_credit: no such user';
end if;
end;
$$;
revoke all on function public.grant_founding_credit(uuid) from public;
grant  execute on function public.grant_founding_credit(uuid) to authenticated;

-- Authorize an existing account to found an ensemble, keyed by email. The director-invite route uses
-- this when the invited address already has an account (a current member starting their own
-- ensemble): there is no invite to send, so grant the credit to the existing account and let them
-- create the ensemble from Your ensembles. Admin gated and idempotent, exactly like
-- grant_founding_credit.
--
-- Resolve the id against auth.users, which is canonical, not app_user.email. The mirror is kept
-- current by handle_user_email_change (003) on an auth.users email update, so it is not usually
-- stale, but it is a mirror maintained by a trigger rather than the source of truth. Reading the
-- source directly costs nothing and does not depend on that trigger firing. The definer owner is what reads auth.users; `limit 1` guards against a
-- duplicate. Returns true when an account was found and its credit ensured, false when none has that
-- address.
create or replace function public.grant_founding_credit_by_email(p_email text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid uuid;
begin
if not public.auth_is_platform_admin() then
raise exception 'grant_founding_credit_by_email: not a platform admin';
end if;
select id into v_uid from auth.users where lower(email) = lower(p_email) order by created_at limit 1;
if v_uid is null then
return false;
end if;
update public.app_user set founding_credits = 1
where id = v_uid and founding_credits = 0;
return true;
end;
$$;
revoke all on function public.grant_founding_credit_by_email(text) from public;
grant  execute on function public.grant_founding_credit_by_email(text) to authenticated;

-- Consume one founding credit for the caller, atomically. The `where founding_credits > 0` update
-- row-locks the caller's app_user row, so two concurrent creates cannot spend one credit twice: the
-- second sees the decremented value and fails. Internal, granted to no client role, called only by
-- create_ensemble_seeded, which runs as the definer owner.
create or replace function public.consume_founding_credit()
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid uuid := auth.uid();
begin
if v_uid is null then
raise exception 'consume_founding_credit: not authenticated';
end if;
update public.app_user set founding_credits = founding_credits - 1
where id = v_uid and founding_credits > 0;
if not found then
raise exception 'not authorized to found an ensemble';
end if;
end;
$$;
revoke all on function public.consume_founding_credit() from public;

-- The only ensemble founder. Creates the tenant, the caller as its first director, and a
-- minimum-viable vocabulary in one transaction, so a brand-new tenant is never too empty to draft.
-- SECURITY DEFINER because it writes the first member row before any membership exists to authorize
-- it.
--
-- The advisory lock covers the credit consume, the quota count, and the inserts together, so a
-- concurrent pair cannot both pass the count. Everything runs in one transaction, so a failed create
-- rolls the credit back with the rest. The 20-owned cap is far above a real director's needs, most
-- run one to three, while refusing mass creation.
create or replace function public.create_ensemble_seeded(p_name text, p_display_name text)
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
-- Serialize this account's founding so the credit consume + quota count + insert are atomic together.
perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
perform public.consume_founding_credit();
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
revoke all on function public.create_ensemble_seeded(text, text) from public;
grant  execute on function public.create_ensemble_seeded(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Director-side invite helpers
-- ----------------------------------------------------------------------------

-- Does this email's account already hold a seat in this ensemble, and is it active or inactive? A
-- person can hold only one seat per ensemble, so inviting an address that already has one is a dead
-- end: the invite would pend forever with no feedback. This lets the invite flow detect that up front
-- and steer the director to reactivate the existing seat instead.
--
-- SECURITY DEFINER to read auth.users, the email to user_id map a plain query cannot reach, and gated
-- to a director OF THIS ensemble through auth_member_tier. So it reveals only a within-ensemble roster
-- fact the caller already has, a member's seat and status, never a cross-tenant fact and never the
-- email of anyone the caller did not just type. Returns at most one row, and none for a non-director
-- caller or an address with no claimed seat here.
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

-- Set a member's status and, when deactivating, prune their coverage and revoke their pending invite,
-- atomically. Invoker, so the director's own policies authorize both writes.
create or replace function public.set_member_status(p_ensemble uuid, p_member uuid, p_status text)
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
revoke all on function public.set_member_status(uuid, uuid, text) from public;
grant  execute on function public.set_member_status(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Invitee-side invitation handling
-- ----------------------------------------------------------------------------
--
-- Joining an ensemble is the invitee's decision. There is no bind-everything path: list, accept, and
-- decline replace it, and each acts on one named ensemble.
--
-- A definer reader is not optional here. An invitee holds no member row yet, so member_read,
-- ensemble_read and member_invite_read all resolve to nothing for them: they cannot read the
-- ensemble's name, the seat that names them, or the invitation itself. Without these functions the
-- accept screen would have nothing to render.
--
-- Every one of them keys on auth.email() rather than on an argument, so a caller can only see or act
-- on invitations addressed to their own address. The ensemble id argument narrows that set; it
-- cannot widen it.
--
-- "Confirmed" holds for the read and the bind, not for the refusal. list_pending_invitations and
-- accept_invitation both require a confirmed email; decline_invitation checks only that the address
-- matches. So an unconfirmed pre-registration on someone else's address can decline that person's
-- invitations, and since nothing clears declined_at the refusal is permanent.

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
-- invitation that appears to be still waiting. The seat stays unclaimed, but it is not re-invitable:
-- nothing clears declined_at, and both list_pending_invitations and accept_invitation require it to
-- be null. A director re-invite bumps invited_at and reports success while the invitee never sees
-- the invitation. Deleting the seat is the only way back.
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

-- Renew and report a PENDING member invitation for this email. The unauthenticated self-serve resend
-- calls it, so a resend goes only to an address that actually has a waiting invite and is never an
-- open relay to arbitrary inboxes. A member_invite row is deleted on accept and on seat removal, so
-- a row means the seat was invited and never claimed. It does not mean the invite is still live: a
-- declined row also stays, which is why the eligibility predicate below tests declined_at is null
-- rather than treating the row's existence as the signal.
--
-- For every eligible seat under the address it bumps invited_at to now, so a seat that had aged past
-- the 14-day bind window can bind again on accept. That matches the director resend, which also
-- refreshes invited_at. Archived and suspended ensembles are skipped, since accept refuses them and a
-- resend there would be a dead-end email. A declined invitation is skipped too: the resend path must
-- not resurrect a refusal.
--
-- first_invited_at is the anchor this path cannot move. It is set once when the row is created and
-- never written again, so 30 days is a hard ceiling on self-serve renewal. Without it, roughly one
-- request a fortnight from anyone who knows the address would keep the seat bindable forever and the
-- 14-day expiry would never arrive. 30 days is a little over twice the link lifetime, which covers
-- the case the route exists for, an invitee returning for a link that expired while they were not
-- looking. Past that, the right remedy is the director re-inviting, which is authenticated and
-- deliberate. A director's own resend writes invited_at through RLS and never passes through here, so
-- the cap does not touch them.
--
-- The second of the two service_role grants. Read the rule stated above consume_invite_quota_by_email
-- before adding a third.
create or replace function public.refresh_pending_invite(p_email text)
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
revoke all on function public.refresh_pending_invite(text) from public;
grant  execute on function public.refresh_pending_invite(text) to service_role;
