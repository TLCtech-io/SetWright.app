-- Fast, GoTrue-safe data reset for the integration suite (see apps/web/test/integration/helpers.ts).
--
-- Why not `supabase db reset`? That drops and recreates the whole database, which severs GoTrue's
-- connection and makes the Kong gateway 502 the token endpoint until GoTrue reconnects. Run 11x
-- back-to-back on a loaded CI runner, that reconnect occasionally stalls for minutes, so domains
-- flakily failed with "AuthRetryableFetchError status=502". Resetting the DATA over the live
-- connection instead never disturbs GoTrue, so there is no readiness race.
--
-- Runs ONLY against the local stack (the DB_URL comes from `supabase status`). We set the local
-- stack's well-known PUBLIC jwt secret so seed.sql's local-only guard passes even though we are not
-- going through `supabase db reset` (which sets it in its own session). This is not a credential —
-- it is the same demo secret in every local Supabase install.
set app.settings.jwt_secret = 'super-secret-jwt-token-with-at-least-32-characters-long';

-- Truncate every app table, then the auth users. CASCADE handles FK order. No RESTART IDENTITY resets
-- sequences. auth.users last, so its cascade into the (already-empty) public tables is a no-op. The
-- reseed below re-inserts auth.users, which re-fires on_auth_user_created to repopulate app_user.
do $$
declare
r record;
begin
-- No RESTART IDENTITY: truncating auth.users cascades to auth.refresh_tokens, whose sequence is
-- owned by supabase_auth_admin (not the postgres role this connects as), so restarting it is
-- denied ("must be owner of sequence refresh_tokens_id_seq"). We don't need it — every entity
-- keys off UUIDs, so leaving the internal sequences alone is harmless.
for r in select tablename from pg_tables where schemaname = 'public' loop
execute format('truncate table public.%I cascade', r.tablename);
end loop;
truncate table auth.users cascade;
end $$;

-- The reseed (seed.sql) is concatenated after this file and piped to psql as ONE session by
-- resetDb(), so the jwt_secret set above is still in effect when seed.sql's local guard runs.
-- (No \i/\ir include — piping via stdin avoids any cwd/path fragility.)
