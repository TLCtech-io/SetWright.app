-- ============================================================================
-- Trigger functions and the triggers that fire them.
--
-- Two jobs live here. The `handle_*` pair mirrors auth.users into app_user. The
-- `guard_*` set enforces invariants that RLS cannot express: RLS is row-level and
-- has no OLD row in WITH CHECK, so column ownership, immutability, and
-- "the last director may not leave" all need a BEFORE trigger.
--
-- Ordering. Functions come first, then triggers, because a trigger names its
-- function. This file depends on 001 for the tables and the moddatetime
-- extension, and on 002 for auth_is_self, which guard_casting_confidence calls.
-- It must run before 004 through 007: several RPCs there write through these
-- guards and two of them vouch for themselves with a transaction-local GUC that
-- only these functions read.
--
-- Trigger name ordering is load-bearing on member. BEFORE triggers fire in
-- alphabetical order, so member_last_director_guard runs before
-- member_seat_binding_guard and reports the more specific rule when a seat is
-- both the sole director and being unbound. Renaming either one silently changes
-- which guard answers.
--
-- Every guard is SECURITY INVOKER. They constrain the caller, so they must see
-- the caller's identity and privileges. The two handle_* functions are SECURITY
-- DEFINER because they write app_user, whose RLS is self-only, from a GoTrue
-- trigger on auth.users. All of them pin search_path to pg_catalog, pg_temp and
-- schema-qualify what they touch.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Account mirror
-- ----------------------------------------------------------------------------

-- A Supabase user is born in auth.users. Mirror it into app_user so there is always
-- a profile for provenance columns and member.user_id to point at. The admin invite
-- for a new member creates the auth user, so it fires this same trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
insert into public.app_user (id, email, display_name)
values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''),
        split_part(new.email, '@', 1))
);
return new;
end;
$$;

-- app_user.email is a convenience mirror; auth.users is canonical. handle_new_user
-- populates it on insert, but a member changing their address through
-- updateUser({email}) writes auth.users long after that, so the mirror would go
-- stale. GoTrue writes the new address only once the change is confirmed on both
-- old and new under double_confirm_changes, so this fires on the settled value and
-- no pending state ever leaks into the mirror.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.app_user
set email = new.email,
updated_at = now()
where id = new.id;
return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- Column ownership: casting.self_reported_confidence
-- ----------------------------------------------------------------------------

-- The director writes a casting's assignment and their own read (director_assessed).
-- The cast member alone owns self_reported_confidence. RLS is row-level and cannot
-- exclude one column, so this trigger does it.
--
-- The INSERT branch exists because a director could otherwise rewrite a member's
-- self-report by deleting and re-inserting the casting row. Nulling the column on
-- every non-self insert would break set_song_casting, which deletes and re-inserts
-- each casting carrying the member's preserved prior value, running as the director.
-- So set_song_casting signals its legitimate re-insert with a transaction-local GUC
-- and the trigger trusts only that. set_config is called with is_local = true, so the
-- flag resets at transaction end and never leaks across a pooled connection. A raw
-- director insert is a different transaction, carries no flag, and is guarded.
--
-- Seed and service contexts have no JWT, so auth.uid() is null and they pass
-- untouched. The member's own set_my_confidence path is an update as self.
create or replace function public.guard_casting_confidence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if tg_op = 'INSERT' then
-- set_song_casting re-inserting the member's preserved value, vouched for by its txn-local flag.
if coalesce(current_setting('app.casting_writer', true), '') = 'rpc' then
return new;
end if;
-- Anyone else: the cast member may seed their own confidence; a director/other may not.
if new.self_reported_confidence is not null
and auth.uid() is not null
and not public.auth_is_self(new.member_id) then
new.self_reported_confidence := null;
end if;
return new;
end if;

-- UPDATE: keep the prior value if anyone but the member changes it.
if new.self_reported_confidence is distinct from old.self_reported_confidence
and auth.uid() is not null
and not public.auth_is_self(new.member_id) then
new.self_reported_confidence := old.self_reported_confidence;
end if;
return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- Performed history is immutable
-- ----------------------------------------------------------------------------
--
-- A director holds a table-level write grant, so the app layer alone cannot protect
-- the record: a direct authenticated write through the Data API bypasses every RPC
-- and repository check. These guards close it at the table boundary.
--
-- perform_setlist stays compatible on purpose. It writes the children while the
-- parent setlist is still 'draft' and flips the parent to 'performed' last, so the
-- child guard sees a draft parent and the parent guard sees old.status <> 'performed'.

-- An event with performed history cannot be deleted. Its performed sets are the record.
create or replace function public.guard_event_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if exists (select 1 from public.setlist s where s.event_id = old.id and s.status = 'performed') then
raise exception 'cannot delete an event with performed history';
end if;
return old;
end;
$$;

-- The frozen children of a performed setlist: order, breaks, soloist snapshots.
--
-- Both sides are checked. Checking only the new parent would let a director re-parent
-- a frozen child onto a draft set and pull it out of history; checking only the old
-- parent would let a fresh row land inside a set that is already performed.
--
-- A cascade from deleting a NON-performed parent still passes: the parent row is gone
-- by then, so the lookup finds nothing and v_status is null. A performed parent can
-- never be deleted at all, so its children are never reached by cascade.
create or replace function public.guard_performed_child()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_status text;
begin
if tg_op in ('UPDATE', 'DELETE') then
select s.status into v_status from public.setlist s where s.id = old.setlist_id;
if v_status = 'performed' then
raise exception 'performed setlist history is immutable';
end if;
end if;
if tg_op in ('INSERT', 'UPDATE') then
select s.status into v_status from public.setlist s where s.id = new.setlist_id;
if v_status = 'performed' then
raise exception 'cannot write into a performed setlist';
end if;
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- The parent setlist. Immutable once performed, and the draft-to-performed flip belongs
-- to perform_setlist alone. Without that second rule a director could patch status
-- straight to 'performed' and produce a set with no frozen order, no soloist snapshots,
-- and a null performed_date. perform_setlist vouches with a transaction-local GUC, the
-- same pattern guard_casting_confidence uses; a raw patch carries no flag.
create or replace function public.guard_performed_setlist()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if old.status = 'performed' then
raise exception 'performed setlists are immutable';
end if;
if tg_op = 'UPDATE' and new.status = 'performed'
and coalesce(current_setting('app.perform_writer', true), '') <> 'rpc' then
raise exception 'a setlist can only be performed through perform_setlist';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;


-- ----------------------------------------------------------------------------
-- Event kind is immutable
-- ----------------------------------------------------------------------------

-- save_event fixes kind on insert and never updates it, but a director's table-level
-- update grant makes the RPC skippable. Flipping a gig to a rehearsal would orphan its
-- setlist and performed history; the reverse would leave a gig with no set.
create or replace function public.guard_event_kind_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if new.kind is distinct from old.kind then
raise exception 'event.kind is immutable (was %, got %)', old.kind, new.kind;
end if;
return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- Member seat invariants
-- ----------------------------------------------------------------------------

-- An ensemble must keep at least one active director with an account on the seat.
-- The invariant used to live in the app as a read-then-write with no lock, so a direct
-- write could orphan a tenant and two concurrent demotions could both pass. FOR UPDATE
-- locks the surviving directors, which serializes concurrent attempts: neither can see
-- a survivor the other is in the middle of removing.
--
-- Unbinding user_id or moving the seat to another ensemble counts as losing the role,
-- because either one leaves the tenant without a director anyone can sign in as.
create or replace function public.guard_last_director()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid := old.ensemble_id;
begin
if old.permission_tier = 'director' and old.status = 'active' and old.user_id is not null
and (tg_op = 'DELETE' or new.permission_tier <> 'director' or new.status <> 'active'
    or new.user_id is null or new.ensemble_id is distinct from old.ensemble_id)
and not exists (
    select 1 from public.member m
    where m.ensemble_id = v_ensemble
    and m.permission_tier = 'director'
    and m.status = 'active'
    and m.user_id is not null
    and m.id <> old.id
    for update
) then
raise exception 'an ensemble must keep at least one active director';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Binding an account to a seat is the invitee's act, not the director's.
--
-- The member write policy's only predicate is director-of-this-ensemble, and the
-- authenticated role holds insert as well as update. Without this guard a director
-- could write any app_user.id they can see onto a seat, making that account an active
-- member of a tenant it never joined. Moving a claimed seat's ensemble_id reaches the
-- same outcome without touching user_id at all, so both columns are guarded.
--
-- Why a trigger and not column privileges. Pinning the authenticated role's UPDATE to
-- a column list closes the same paths, but the list has to be re-derived every time a
-- member column is added, and getting it wrong breaks roster editing at runtime with a
-- privilege error no offline gate would catch. This names two columns and is
-- indifferent to the rest of the table. An RLS WITH CHECK cannot express it at all,
-- because WITH CHECK has no OLD row.
create or replace function public.guard_member_binding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
-- Only the Data API roles are guarded. The SECURITY DEFINER functions that legitimately
-- bind a seat are owned by postgres, so current_user is postgres inside them and their
-- binds pass. Seed, migration and service-role writes sit outside these roles too.
if current_user not in ('authenticated', 'anon') then
    return new;
end if;

-- The auth.uid() escape keeps this from resting on the SECURITY DEFINER current_user
-- behaviour alone: a caller may only ever write their OWN account onto a seat. A
-- director self-binding to a second seat in their own ensemble is the only thing it
-- permits, and member_ensemble_id_user_id_key already refuses that.
if tg_op = 'INSERT' then
    if new.user_id is not null and new.user_id is distinct from auth.uid() then
        raise exception 'a member seat cannot be created already bound to an account'
            using errcode = 'insufficient_privilege';
    end if;
    return new;
end if;

if new.user_id is distinct from old.user_id
and new.user_id is distinct from auth.uid() then
    raise exception 'the account on a member seat is set by the invitee, not by a director'
        using errcode = 'insufficient_privilege';
end if;

if new.ensemble_id is distinct from old.ensemble_id then
    raise exception 'a member seat cannot be moved to another ensemble'
        using errcode = 'insufficient_privilege';
end if;

return new;
end;
$$;


-- ============================================================================
-- Triggers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- auth.users. These two sit on a GoTrue table, not a public one, which is why the
-- functions above are SECURITY DEFINER.
-- ----------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- `after update of email` plus the WHEN guard: the body runs only when the address
-- actually changed, so an unrelated auth.users update (last sign-in, metadata) never
-- touches the mirror.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email on auth.users
for each row
when (new.email is distinct from old.email)
execute function public.handle_user_email_change();


-- ----------------------------------------------------------------------------
-- Guards
-- ----------------------------------------------------------------------------

create trigger casting_confidence_owner
before insert or update on public.casting
for each row execute function public.guard_casting_confidence();

create trigger event_history_delete_guard
before delete on public.event
for each row execute function public.guard_event_history();

create trigger event_kind_immutable
before update on public.event
for each row execute function public.guard_event_kind_immutable();

create trigger setlist_immutable_guard
before update or delete on public.setlist
for each row execute function public.guard_performed_setlist();

create trigger setlist_item_immutable_guard
before insert or update or delete on public.setlist_item
for each row execute function public.guard_performed_child();

create trigger setlist_break_immutable_guard
before insert or update or delete on public.setlist_break
for each row execute function public.guard_performed_child();

create trigger performance_soloist_immutable_guard
before insert or update or delete on public.performance_soloist
for each row execute function public.guard_performed_child();

create trigger member_last_director_guard
before update or delete on public.member
for each row execute function public.guard_last_director();

-- `update of user_id, ensemble_id` fires only when one of those columns is in the SET
-- list, so an ordinary roster edit pays nothing. See the header on why this name has
-- to sort after member_last_director_guard.
create trigger member_seat_binding_guard
before insert or update of user_id, ensemble_id on public.member
for each row execute function public.guard_member_binding();


-- ----------------------------------------------------------------------------
-- updated_at maintenance
--
-- moddatetime comes from the extension created in 001. Every table with an updated_at
-- column gets one; the list is explicit rather than derived from the catalog so adding
-- a table is a deliberate act.
-- ----------------------------------------------------------------------------

do $$
declare
t text;
begin
foreach t in array array[
'app_user','ensemble','member','voice_part','song','part','casting',
'event','event_type','padding_profile','tag','availability',
'program','program_item','setlist','setlist_item','setlist_break'
]
loop
execute format(
    'create trigger %I_set_updated_at before update on public.%I '
    'for each row execute function public.moddatetime(updated_at)', t, t);
end loop;
end $$;
