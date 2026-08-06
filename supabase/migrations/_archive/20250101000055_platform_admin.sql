-- Track 2 (invite-first front door), phase A: the platform-admin flag and its guard.
--
-- A platform admin (operator / sales) issues director invites through the /admin surface. The flag is
-- set out of band by SQL only; no app route can set it, because an endpoint that grants admin would be
-- a privilege-escalation target. Bootstrap the first admin with a direct UPDATE against the production
-- DB (see the go-live checklist). The flag ONLY authorizes the /admin route/page and the admin-invite
-- surface. It grants NO cross-tenant data access: no RLS policy references it, so a platform admin
-- still cannot read another ensemble's rows.

alter table app_user add column is_platform_admin boolean not null default false;

-- Self-promotion guard. `authenticated` holds a blanket table-level UPDATE on every public table
-- (rls.sql), and app_user_update lets a user update their OWN app_user row. Together that would let
-- anyone PATCH is_platform_admin = true on themselves via PostgREST and self-promote. Column
-- privileges are checked independently of RLS, so pin authenticated's UPDATE to the self-editable
-- columns; the admin flag is then unwritable by authenticated at all, leaving only service_role and the
-- SQL bootstrap able to set it. The app never PATCHes app_user directly (profile edits go through the
-- update_my_profile DEFINER RPC), so this narrows nothing the app relies on.
revoke update on app_user from authenticated;
grant  update (email, display_name) on app_user to authenticated;

-- True when the caller is a platform admin. SECURITY DEFINER + pinned search_path, mirroring
-- auth_member_tier so it can be read from a policy or an RPC without recursing. proxy.ts and the admin
-- route call it to gate the surface. A null auth.uid() (anonymous) coalesces to false.
create or replace function auth_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
select coalesce(
    (select u.is_platform_admin from public.app_user u where u.id = auth.uid()),
    false
);
$$;
revoke all on function auth_is_platform_admin() from public;
grant  execute on function auth_is_platform_admin() to authenticated;
