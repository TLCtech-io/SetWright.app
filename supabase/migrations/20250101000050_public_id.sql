-- Add a URL-facing public identifier to every routable entity. The URL carries this opaque token
-- so an internal uuid never leaks into a shareable link, while the uuid stays the join key below
-- the routing layer: RLS, every foreign key, and the active_ensemble cookie are all uuid, all
-- unchanged. Six tables get one: ensemble, song, member, setlist, event, program. The remaining
-- id-bearing tables are API internals that never sit in a URL, so they stay uuid-only.
--
-- Token: base64url of 16 random bytes, padding stripped, so exactly 22 chars (^[A-Za-z0-9_-]{22}$).
-- The app-layer validator and a matching generator live in apps/web/lib/publicId.ts; this is the
-- database default. The bytes come from gen_random_uuid() (built-in on PG13+), so the migration
-- needs no extension. That is 122 bits of entropy: unguessable and collision-free at any real
-- scale. RLS still draws tenancy, so the token is an identifier, not a secret.

-- Volatile on purpose. ADD COLUMN with a volatile default evaluates it once per existing row, so
-- the backfill gives every row a distinct token. A non-volatile default would reuse a single value
-- and the unique index below would then fail. New inserts (the onboarding seed, create_ensemble_
-- seeded, every app write) omit public_id and take this default, so nothing downstream changes.
create or replace function public.gen_public_id()
returns text
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
select rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=');
$$;

alter table public.ensemble add column public_id text not null default public.gen_public_id();
alter table public.song     add column public_id text not null default public.gen_public_id();
alter table public.member   add column public_id text not null default public.gen_public_id();
alter table public.setlist  add column public_id text not null default public.gen_public_id();
alter table public.event    add column public_id text not null default public.gen_public_id();
alter table public.program  add column public_id text not null default public.gen_public_id();

-- Unique per table. A b-tree unique index also serves the token -> row point lookups the routing
-- layer runs (resolvePublicId, the proxy's ensemble resolution), so no separate lookup index.
create unique index idx_ensemble_public_id on public.ensemble (public_id);
create unique index idx_song_public_id     on public.song (public_id);
create unique index idx_member_public_id   on public.member (public_id);
create unique index idx_setlist_public_id  on public.setlist (public_id);
create unique index idx_event_public_id    on public.event (public_id);
create unique index idx_program_public_id  on public.program (public_id);
