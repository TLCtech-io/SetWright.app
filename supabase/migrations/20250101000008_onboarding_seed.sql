-- ============================================================================
-- Transactional onboarding (G2.2). create_ensemble makes only the ensemble + first
-- director, so a brand-new tenant starts too empty to draft (no voice parts, tags,
-- padding, or event types). create_ensemble_seeded does the whole thing atomically:
-- the ensemble, the caller as director, and a minimum-viable vocabulary. The signup
-- flow and the "create ensemble" action both call it; an existing director calling it
-- simply gains another ensemble (the multi-ensemble path).
--
-- SECURITY DEFINER like create_ensemble: it writes the first member before any
-- membership exists to authorize it, and the defaults follow in the same transaction.
-- ============================================================================

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

insert into public.ensemble (name, created_by, updated_by)
values (p_name, v_uid, v_uid)
returning id into v_ensemble;

insert into public.member (ensemble_id, user_id, display_name, permission_tier, status, created_by, updated_by)
values (v_ensemble, v_uid, coalesce(p_display_name, 'Director'), 'director', 'active', v_uid, v_uid);

-- Minimum-viable vocabulary so the ensemble can draft on day one.
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
