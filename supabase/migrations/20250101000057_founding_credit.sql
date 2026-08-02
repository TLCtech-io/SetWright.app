-- Track 2 (invite-first front door): admin-authorized ensemble creation.
--
-- Today create_ensemble_seeded is granted to authenticated and gated only by the 20-owned quota, so any
-- member can call it (directly via PostgREST, or through /ensembles) and become the director of a new
-- ensemble for free. That is the exact door the invite-first / director-pays model must control. Closing
-- the UI is not enough, because the RPC is directly callable; the gate has to live in SQL.
--
-- Gate founding on a per-user credit. app_user.founding_credits (default 0) is granted only by a platform
-- admin (grant_founding_credit, below) and consumed atomically inside create_ensemble_seeded. A plain
-- member has 0 credits and is refused. The admin invite (the only director on-ramp) grants exactly one
-- credit, which the confirm-route seeding consumes. The 20-owned quota stays as a backstop. create_ensemble
-- (the bare, vocabulary-less founder) was dropped in migration 028 and stays dropped; only the seeded
-- founder survives, so only it is gated here.

alter table app_user add column founding_credits int not null default 0;

-- A platform admin authorizes one founding for a user. SECURITY DEFINER so it can write app_user (which
-- authenticated cannot, per migration 055), gated internally on the caller being a platform admin. The
-- admin invite route calls this via the admin's own (authenticated) client.
create or replace function grant_founding_credit(p_user_id uuid)
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
revoke all on function grant_founding_credit(uuid) from public;
grant  execute on function grant_founding_credit(uuid) to authenticated;

-- Authorize an EXISTING account to found an ensemble, keyed by email. The director-invite route uses this
-- when the invited email already has an account (a current member starting their own ensemble): there is
-- no invite to send, so grant the credit to their existing account and let them create the ensemble
-- themselves from Your ensembles. Admin-gated and idempotent, exactly like grant_founding_credit.
-- Resolve the id against auth.users (CANONICAL), not app_user.email: that mirror is only set on insert
-- and lags an email change, so looking it up there would strand the admin (or, with a reused email, grab
-- the wrong row). The definer owner reads auth.users; `limit 1` guards against any duplicate. Returns true
-- when an account was found (credit ensured), false when no account has that email.
create or replace function grant_founding_credit_by_email(p_email text)
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
revoke all on function grant_founding_credit_by_email(text) from public;
grant  execute on function grant_founding_credit_by_email(text) to authenticated;

-- Consume one founding credit for the caller, atomically. The `where founding_credits > 0` UPDATE row-locks
-- the caller's app_user row, so two concurrent creates cannot spend one credit twice; the second sees the
-- decremented value and fails. Raises when the caller has none. Internal: not granted to any client role,
-- called only by create_ensemble_seeded (which runs as the definer owner).
create or replace function consume_founding_credit()
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
revoke all on function consume_founding_credit() from public;

-- Recreate create_ensemble_seeded with the credit consume at the top. Everything else is unchanged from
-- migration 028 (the per-account advisory lock, the 20-owned quota, and the seeded vocabulary). The
-- consume runs inside the same transaction and advisory-lock window, so a failed create rolls the credit
-- back with the rest.
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
revoke all on function create_ensemble_seeded(text, text) from public;
grant  execute on function create_ensemble_seeded(text, text) to authenticated;
