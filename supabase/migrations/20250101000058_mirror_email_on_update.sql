-- Keep app_user.email fresh after a self-service email change.
--
-- app_user.email is a convenience mirror; auth.users is canonical. handle_new_user (migration 002)
-- populates the mirror on INSERT, but a member changing their email through updateUser({email})
-- updates auth.users.email long after that insert, so the mirror would go stale. Add a matching
-- AFTER UPDATE trigger that re-mirrors the address whenever GoTrue flips it.
--
-- Timing: GoTrue writes the new auth.users.email only once the change is CONFIRMED (both the old and
-- new address under double_confirm_changes), so this fires on the real change, never on the pending
-- request. It is the settled value, so no separate "pending" state leaks into the mirror.
--
-- SECURITY DEFINER + pinned search_path mirrors every other definer function here: the update writes
-- app_user (whose RLS is self-only) with RLS bypassed, addressing the row by the auth user's own id.

create or replace function handle_user_email_change()
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

-- AFTER UPDATE OF email + the WHEN guard: the trigger body runs only when the address actually
-- changed, so an unrelated auth.users update (last sign-in, metadata) never touches the mirror.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email on auth.users
for each row
when (new.email is distinct from old.email)
execute function handle_user_email_change();
