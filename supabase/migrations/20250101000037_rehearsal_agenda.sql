-- Rehearsal planner, phase R2: the rehearsal agenda.
--
-- A rehearsal's plan is an ordered, editable list of songs to run, each with a reason
-- (why it was suggested) and an optional director note. It is a sibling of program_item
-- and setlist_item: a child of event, composite-FK'd for tenant integrity, position by
-- array order. Only rehearsals carry one; a gig's plan is its setlist.
--
-- The suggestions that seed the list (coverage risk, learning gaps, staleness, upcoming
-- gig) are computed in the web layer from signals that already exist. This migration only
-- stores the director's curated result. Nothing here reads it as a drafter signal.

create table public.rehearsal_item (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references public.ensemble(id),
    event_id    uuid not null,
    song_id     uuid not null,
    position    smallint not null,               -- order in the agenda
    reason      text,                            -- 'coverage-risk' | 'learning-gap' | 'stale' | 'upcoming-gig' | null (director pick)
    note        text,                            -- director's rehearsal note for this song
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references public.app_user(id) on delete set null,
    updated_by  uuid references public.app_user(id) on delete set null,
    
    unique (event_id, song_id),
    foreign key (ensemble_id, event_id) references public.event(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, song_id)  references public.song(ensemble_id, id)  on delete cascade
);
create index idx_rehearsal_item_event    on public.rehearsal_item (event_id);
create index idx_rehearsal_item_ensemble on public.rehearsal_item (ensemble_id);

-- RLS + grant. rehearsal_item is added after the schema-time blanket grant and the
-- policy loops in rls.sql (which enumerate a fixed table list), so it needs its own
-- grant and policies here. Same shape as program_item: any member reads, only a
-- director writes.
grant select, insert, update, delete on public.rehearsal_item to authenticated;

alter table public.rehearsal_item enable row level security;

create policy rehearsal_item_read on public.rehearsal_item
for select using (auth_member_tier(ensemble_id) is not null);

create policy rehearsal_item_write on public.rehearsal_item
for all using (auth_member_tier(ensemble_id) = 'director')
with check (auth_member_tier(ensemble_id) = 'director');


-- Replace a rehearsal's agenda atomically: delete the old items, insert the new ones
-- in array order (position from ordinality). Mirrors save_program's delete-then-insert
-- and save_song's jsonb-with-ordinality. p_items is a JSON array of
-- {song_id, reason, note}. Director-write is enforced by RLS (security invoker), same
-- as save_program; the event lock scopes the tenant. Guards kind so a gig can never
-- acquire an agenda, mirroring the setlist route's inverse guard.
create or replace function save_rehearsal_agenda(p_event uuid, p_items jsonb)
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
if v_kind is distinct from 'rehearsal' then
raise exception 'save_rehearsal_agenda: event % is not a rehearsal', p_event;
end if;

delete from public.rehearsal_item where ensemble_id = v_ensemble and event_id = p_event;
-- Dedupe by song (keep the first occurrence), then re-rank to gapless positions in the
-- submitted order. The unique(event_id, song_id) constraint is the backstop; deduping
-- here matches the mock and the route so a repeated song never aborts the whole write.
insert into public.rehearsal_item (ensemble_id, event_id, song_id, position, reason, note)
select v_ensemble, p_event, d.song_id,
(row_number() over (order by d.ord) - 1)::smallint,
d.reason, d.note
from (
    select distinct on ((item.value->>'song_id')::uuid)
    (item.value->>'song_id')::uuid as song_id,
    item.ordinality as ord,
    nullif(btrim(item.value->>'reason'), '') as reason,
    nullif(btrim(item.value->>'note'), '') as note
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as item(value, ordinality)
    order by (item.value->>'song_id')::uuid, item.ordinality
) d;
end;
$$;
revoke all on function save_rehearsal_agenda(uuid, jsonb) from public;
grant  execute on function save_rehearsal_agenda(uuid, jsonb) to authenticated;
