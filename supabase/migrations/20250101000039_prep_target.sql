-- Rehearsal planner, phase R4: deadlines (the song-to-target-gig edge).
--
-- A prep target is an explicit commitment: "have this song ready for that gig". The gig's
-- event_date is the deadline. Nothing modeled this before: setlist is the performed output,
-- event_tag prefer softly steers a draft, but neither says "we are learning X for show Y".
-- This edge drives the "behind schedule" view: a targeted song that is not performance-ready
-- or not fully cast, with an upcoming gig date bearing down.
--
-- A per-gig set of songs (unordered), sibling of the other event-child tables. Gigs only:
-- a rehearsal is the preparation, it does not have prep targets of its own.

create table public.prep_target (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references public.ensemble(id),
    event_id    uuid not null,
    song_id     uuid not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references public.app_user(id) on delete set null,
    updated_by  uuid references public.app_user(id) on delete set null,
    
    unique (event_id, song_id),
    foreign key (ensemble_id, event_id) references public.event(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, song_id)  references public.song(ensemble_id, id)  on delete cascade
);
create index idx_prep_target_event    on public.prep_target (event_id);
create index idx_prep_target_ensemble on public.prep_target (ensemble_id);

-- RLS + grant, added after the schema-time blanket grant and the rls.sql policy loops.
-- Any member reads; only a director sets the prep list. Same shape as rehearsal_item.
grant select, insert, update, delete on public.prep_target to authenticated;

alter table public.prep_target enable row level security;

create policy prep_target_read on public.prep_target
for select using (auth_member_tier(ensemble_id) is not null);

create policy prep_target_write on public.prep_target
for all using (auth_member_tier(ensemble_id) = 'director')
with check (auth_member_tier(ensemble_id) = 'director');


-- Replace a gig's prep-target set in one write: delete the old, insert the submitted song
-- ids. Kind-guarded so only a gig acquires targets (a rehearsal is the prep, mirrors the
-- rehearsal-agenda guard, inverted). Director-write is enforced by RLS (security invoker),
-- like save_program. Deduped by song via the unique constraint plus distinct here, so a
-- repeated id can't abort the write.
create or replace function save_prep_targets(p_event uuid, p_song_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_kind     text;
begin
select ensemble_id, kind into v_ensemble, v_kind
from public.event where id = p_event for update;
if v_ensemble is null then return; end if;
if v_kind is distinct from 'gig' then
raise exception 'save_prep_targets: event % is not a gig', p_event;
end if;

delete from public.prep_target where ensemble_id = v_ensemble and event_id = p_event;
insert into public.prep_target (ensemble_id, event_id, song_id)
select distinct v_ensemble, p_event, s.song_id
from unnest(coalesce(p_song_ids, '{}'::uuid[])) as s(song_id);
end;
$$;
revoke all on function save_prep_targets(uuid, uuid[]) from public;
grant  execute on function save_prep_targets(uuid, uuid[]) to authenticated;
