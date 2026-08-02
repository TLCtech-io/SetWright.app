-- ============================================================================
-- Setlist drafting tool - row-level security (apply AFTER schema.sql)
-- Target: PostgreSQL 13+ / Supabase.
--
-- Model
--   Isolation is by membership, not by a session variable. A user reaches a row
--   when they hold an active member row in that row's ensemble. Their tier on that
--   membership decides writes. The app narrows a screen by filtering on ensemble_id;
--   RLS only draws the hard boundary.
--
-- The recursion trap
--   A policy that guards a row reads the member table to check membership. The member
--   table needs the same guard, so its policy would read member to decide whether you
--   can read member. That recurses. The escape is the two helper functions below:
--   they are SECURITY DEFINER, so they read membership with RLS turned off inside them.
--   Every policy leans on them.
--
-- Tiers
--   For now: director writes the curated data, everyone else reads and writes only
--   their own (availability, and their own confidence/profile through functions).
--   section_leader rides along as a member until the full permission matrix is built.
--
-- What is deliberately NOT here (it is service-role edge code, not SQL)
--   - The auth admin invite that pre-creates an auth user for a brand-new member.
--   - The add-member fork that, for an email already on the platform, links a new
--     member row to the existing app_user instead of inviting. That is a plain
--     director insert into member (covered by the member write policy) plus a
--     service-role lookup of app_user by email.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Helper functions. SECURITY DEFINER + locked search_path is what breaks recursion.
--
-- Hardening (applies to every SECURITY DEFINER function below): the search_path is
-- pinned to `pg_catalog, pg_temp` (NOT public, and pg_temp last) and every table is
-- schema-qualified, so a caller with temp-object rights cannot shadow a relation these
-- definer functions trust. Membership checks also require status = 'active', so a removed
-- user can no longer satisfy a self-write or read as a member.
-- ----------------------------------------------------------------------------

-- The caller's tier in an ensemble, or null if they are not an active member.
create or replace function auth_member_tier(p_ensemble uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select m.permission_tier
from public.member m
where m.ensemble_id = p_ensemble
and m.user_id = auth.uid()
and m.status = 'active'
limit 1;
$$;

-- True when the given member row belongs to the caller. For self-writes.
create or replace function auth_is_self(p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select exists (
    select 1 from public.member m
    where m.id = p_member and m.user_id = auth.uid()
    and m.status = 'active'
);
$$;


-- ----------------------------------------------------------------------------
-- Enable RLS on every table. Without policies this denies all access, which is why
-- the policies follow immediately.
-- ----------------------------------------------------------------------------

do $$
declare t text;
begin
foreach t in array array[
'app_user','ensemble','member','voice_part','member_voice_part',
'song','part','casting','padding_profile','event_type','event',
'tag','song_tag','event_tag','event_type_tag','availability',
'program','program_item','setlist','setlist_item','setlist_break',
'performance_soloist'
]
loop
execute format('alter table %I enable row level security', t);
end loop;
end $$;


-- ----------------------------------------------------------------------------
-- Base-table privileges for the PostgREST roles. Migrations run as `postgres`,
-- whose default privileges confer only REFERENCES/TRIGGER/TRUNCATE on new tables to
-- the API roles, NOT read/write (only supabase_admin's default privileges do). So
-- without this an authenticated user hits "permission denied for table" before RLS
-- is ever consulted. These grants decide only whether a role may touch a table at
-- all; the policies below decide which rows. anon (pre-login) is granted nothing.
-- casting's direct SELECT is revoked again further down (members read it through
-- casting_visible), and create/read/write of new rows still flows through the
-- policies — a non-director's writes match no policy and touch zero rows.
-- ----------------------------------------------------------------------------

grant select, insert, update, delete on all tables in schema public to authenticated;


-- ----------------------------------------------------------------------------
-- The common pattern: any active member reads, the director writes.
-- Applied to the curated data and its link tables.
-- ----------------------------------------------------------------------------

do $$
declare t text;
begin
foreach t in array array[
'voice_part','member_voice_part','song','part','padding_profile',
'event_type','event','tag','song_tag','event_tag','event_type_tag',
'program','program_item','setlist','setlist_item','setlist_break',
'performance_soloist'
]
loop
execute format(
    'create policy %1$s_read on %1$I for select '
    'using (auth_member_tier(ensemble_id) is not null)', t);
execute format(
    'create policy %1$s_write on %1$I for all '
    'using (auth_member_tier(ensemble_id) = ''director'') '
    'with check (auth_member_tier(ensemble_id) = ''director'')', t);
end loop;
end $$;


-- ----------------------------------------------------------------------------
-- The tables that sit apart.
-- ----------------------------------------------------------------------------

-- app_user: self only. In-group display names come from member.display_name, not here.
-- Inserts happen through the auth.users trigger (below), so there is no insert policy.
create policy app_user_read on app_user
for select using (id = auth.uid());
create policy app_user_update on app_user
for update using (id = auth.uid()) with check (id = auth.uid());

-- ensemble: members read, the director updates. Creation is the chicken-and-egg case,
-- handled by create_ensemble (below), so there is no insert policy. No hard delete;
-- retire a tenant with status = 'archived'.
create policy ensemble_read on ensemble
for select using (auth_member_tier(id) is not null);
create policy ensemble_update on ensemble
for update using (auth_member_tier(id) = 'director')
with check (auth_member_tier(id) = 'director');

-- member: read the roster of your ensembles, plus your own row anywhere. The director
-- writes the roster. A member edits their own name and range through update_my_profile,
-- not here, so that they cannot touch their own tier.
create policy member_read on member
for select using (auth_member_tier(ensemble_id) is not null or user_id = auth.uid());
create policy member_write on member
for all using (auth_member_tier(ensemble_id) = 'director')
with check (auth_member_tier(ensemble_id) = 'director');

-- availability: the member owns the whole row, so a self-write policy is enough.
-- A member writes their own attendance, the director writes anyone's.
create policy availability_read on availability
for select using (auth_member_tier(ensemble_id) is not null);
create policy availability_write on availability
for all using (auth_is_self(member_id) or auth_member_tier(ensemble_id) = 'director')
with check (auth_is_self(member_id) or auth_member_tier(ensemble_id) = 'director');


-- ----------------------------------------------------------------------------
-- casting: ownership is per column. The director owns the assignment and is_primary;
-- the member owns self_reported_confidence. RLS is row-level, so it cannot split that.
--
-- Writes: the director writes the row here. Members write their own confidence through
-- set_my_confidence (below), never directly.
-- Reads: closed on the base table and routed through casting_visible, which scopes rows
-- to the caller's ensembles and nulls other people's confidence unless the ensemble is
-- set to 'shared'. This makes 'private' actually hold, not just a UI nicety.
-- ----------------------------------------------------------------------------

create policy casting_insert on casting
for insert with check (auth_member_tier(ensemble_id) = 'director');
create policy casting_update on casting
for update using (auth_member_tier(ensemble_id) = 'director')
with check (auth_member_tier(ensemble_id) = 'director');
create policy casting_delete on casting
for delete using (auth_member_tier(ensemble_id) = 'director');

-- A director reads the base table directly. Two reasons: they own this data and see
-- all of it anyway (the view exposes everything to them), and — load-bearing — a
-- filtered casting write (DELETE/UPDATE ... WHERE part_id in (...)) needs its target
-- rows visible through a SELECT policy, not just the DELETE/UPDATE USING clause. With
-- no SELECT policy a director's own writes would silently match zero rows. Members
-- have no SELECT policy here, so they still reach castings only through casting_visible.
create policy casting_select_director on casting
for select using (auth_member_tier(ensemble_id) = 'director');

-- The view runs with its owner's rights and bypasses casting's RLS, so the WHERE clause
-- is the tenant guard. The CASE is the confidence guard.
create view casting_visible as
select
c.id, c.ensemble_id, c.part_id, c.member_id, c.is_primary,
case
when auth_is_self(c.member_id)                      then c.self_reported_confidence
when auth_member_tier(c.ensemble_id) = 'director'   then c.self_reported_confidence
when e.confidence_visibility = 'shared'             then c.self_reported_confidence
else null
end as self_reported_confidence,
-- The director's private read of each cover (and the date it was confirmed solid).
-- Director-only: a member never sees the director's assessment of anyone, including
-- themselves. This is the read path the learning tracker and casting editor use.
case when auth_member_tier(c.ensemble_id) = 'director' then c.director_assessed end as director_assessed,
case when auth_member_tier(c.ensemble_id) = 'director' then c.learned_at        end as learned_at,
c.created_at, c.updated_at, c.created_by, c.updated_by
from casting c
join ensemble e on e.id = c.ensemble_id
where auth_member_tier(c.ensemble_id) is not null;

-- Members reach castings only through the view (they match no SELECT policy on the
-- base table, so a direct read returns zero rows even with the table privilege). The
-- base-table SELECT privilege from the blanket grant above stays, so the director
-- SELECT policy and director-only filtered writes can resolve their rows.
grant select on casting_visible to authenticated;


-- ----------------------------------------------------------------------------
-- Column-split self-writes. Narrow SECURITY DEFINER functions that touch only the
-- caller-owned column and check ownership in their WHERE. This is how a member edits
-- one field without an open update policy that would let them edit their tier.
-- ----------------------------------------------------------------------------

-- A member sets (or clears) the confidence on their own casting. The value is checked
-- by casting's own CHECK constraint; null is allowed (un-report).
create or replace function set_my_confidence(p_casting uuid, p_confidence text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.casting c
set self_reported_confidence = p_confidence,
updated_by = auth.uid()
where c.id = p_casting
and exists (
    select 1 from public.member m
    where m.id = c.member_id and m.user_id = auth.uid()
    and m.status = 'active'
);
end;
$$;

-- A member edits their own display name and range on one of their member rows.
-- display_name coalesces (it is NOT NULL, so a null arg keeps the current value);
-- the range fields are set directly, so a null arg clears them. Tier, status, and the
-- account link are untouchable here.
create or replace function update_my_profile(
    p_member uuid,
    p_display_name text,
    p_range_low smallint,
    p_range_high smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
update public.member m
set display_name     = coalesce(p_display_name, m.display_name),
vocal_range_low  = p_range_low,
vocal_range_high = p_range_high,
updated_by       = auth.uid()
where m.id = p_member and m.user_id = auth.uid()
and m.status = 'active';
end;
$$;


-- ----------------------------------------------------------------------------
-- Provisioning.
-- ----------------------------------------------------------------------------

-- The founder path. Runs as owner, so it writes the first member row before any
-- membership exists to authorize it. Public signup calls this; it always creates a
-- NEW ensemble with the caller as its director. Joining an existing ensemble is the
-- invite flow, which lives in edge code.
create or replace function create_ensemble(p_name text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid uuid := auth.uid();
v_ensemble uuid;
begin
if v_uid is null then
raise exception 'create_ensemble: not authenticated';
end if;

insert into public.ensemble (name, created_by, updated_by)
values (p_name, v_uid, v_uid)
returning id into v_ensemble;

insert into public.member (ensemble_id, user_id, display_name,
    permission_tier, status, created_by, updated_by)
values (v_ensemble, v_uid, coalesce(p_display_name, 'Director'),
    'director', 'active', v_uid, v_uid);

return v_ensemble;
end;
$$;

-- The account row. A Supabase user is born in auth.users; this mirrors it into app_user
-- so there is always a profile to point provenance and member.user_id at. The admin
-- invite for a new member fires this same trigger by creating the auth user.
create or replace function handle_new_user()
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();


-- ----------------------------------------------------------------------------
-- Execute privileges: only signed-in users call the write functions.
-- ----------------------------------------------------------------------------

revoke all on function set_my_confidence(uuid, text) from public;
grant  execute on function set_my_confidence(uuid, text) to authenticated;

revoke all on function update_my_profile(uuid, text, smallint, smallint) from public;
grant  execute on function update_my_profile(uuid, text, smallint, smallint) to authenticated;

revoke all on function create_ensemble(text, text) from public;
grant  execute on function create_ensemble(text, text) to authenticated;
