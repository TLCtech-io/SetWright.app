-- Drop the superseded bare create_ensemble. create_ensemble_seeded (migration 8) replaced it:
-- the bare version created only an ensemble + first director with NO starter vocabulary (voice
-- parts / tags / padding profiles / event types), so a tenant made through it was unusable. It is
-- still granted to authenticated but is never called anywhere in the app — every onboarding path
-- uses create_ensemble_seeded — so it is a footgun (any authenticated user could mint a broken
-- tenant) with no purpose. Remove it rather than leave a callable trap.
--
-- (The other superseded function, mark_setlist_performed, is entangled with the @repertoire/api
-- PerformSource contract — its removal is a separate cross-package cleanup, tracked separately.)
drop function if exists public.create_ensemble(text, text);
