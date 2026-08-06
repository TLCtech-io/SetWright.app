-- Pin the search_path on the two hydration functions. They are the only functions left in
-- the set without one, so an unpinned resolution is the last place a session-set search_path
-- could decide which table a name means.
--
-- Both are SECURITY INVOKER, so this grants no escalation and takes none away. The value is
-- deterministic resolution, nothing more.
--
-- Note the value differs from the other 93 pins in the set, which are `pg_catalog, pg_temp`.
-- These two reference their tables unqualified, so public has to stay on the path. Naming
-- pg_temp explicitly still puts it last rather than the implicit first, which is the part
-- that carries the security weight.
--
-- ALTER FUNCTION rather than a redeclaration, because the bodies are long and copying them
-- forward to change one attribute is how a schema and its copy drift apart. The signatures
-- are hydrate_draft_input(uuid), last declared in migration 034, and
-- hydrate_setlist_locks(uuid), declared in migration 004.
--
-- CREATE OR REPLACE FUNCTION resets a function's configuration, so any future redeclaration
-- of hydrate_draft_input has to carry the SET clause in its own body or it silently loses
-- this pin. That function has already been redeclared five times (003, 031, 032, 033, 034).
alter function public.hydrate_draft_input(uuid)
    set search_path = pg_catalog, public, pg_temp;

alter function public.hydrate_setlist_locks(uuid)
    set search_path = pg_catalog, public, pg_temp;
