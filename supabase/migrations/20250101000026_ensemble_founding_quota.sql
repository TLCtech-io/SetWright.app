-- Cap how many ensembles one account can found (#6). create_ensemble and create_ensemble_seeded
-- are SECURITY DEFINER and gated only on auth.uid() being non-null, so any authenticated account
-- could create unbounded ensembles (each with seeded vocabulary), a cheap amplification DoS on a
-- multi-tenant service. Recreate both with a per-user quota: at most MAX_OWNED active directorships.
-- 20 is far above a real director's needs (most run 1-3) while refusing mass-creation.
--
-- These live in already-applied migrations (2 and 8), so they are recreated here rather than edited.

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
if (select count(*) from public.member m
    where m.user_id = v_uid and m.permission_tier = 'director' and m.status = 'active') >= 20 then
raise exception 'create_ensemble: you already direct the maximum number of ensembles';
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

revoke all on function create_ensemble(text, text) from public;
grant  execute on function create_ensemble(text, text) to authenticated;

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
if (select count(*) from public.member m
    where m.user_id = v_uid and m.permission_tier = 'director' and m.status = 'active') >= 20 then
raise exception 'create_ensemble_seeded: you already direct the maximum number of ensembles';
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
