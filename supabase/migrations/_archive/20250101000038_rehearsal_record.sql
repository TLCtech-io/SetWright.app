-- Rehearsal planner, phase R3: record what was rehearsed.
--
-- Two writes that close the loop after a rehearsal:
--   1. mark_songs_rehearsed stamps song.last_rehearsed for the songs actually run, so the
--      staleness signal R2 ranks on stays current on its own (a rehearsed song clears its
--      "gone cold" flag). Same monotonic greatest() stamp perform_setlist uses for
--      last_performed. The manual date field on the song form stays as a hand override.
--   2. attendance records who actually came, distinct from RSVP intent. availability answers
--      "who plans to come"; attendance answers "who showed". A new child table keyed
--      (member_id, event_id), so RSVP is never overwritten with an attendance value.

-- Recorded attendance. Mirrors availability's shape; status is a plain present/absent
-- boolean (a missing row = not recorded, matching availability's "no row = no response").
create table public.attendance (
  id          uuid primary key default gen_random_uuid(),
  ensemble_id uuid not null references public.ensemble(id),
  member_id   uuid not null,
  event_id    uuid not null,
  present     boolean not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.app_user(id) on delete set null,
  updated_by  uuid references public.app_user(id) on delete set null,

  unique (member_id, event_id),
  foreign key (ensemble_id, member_id) references public.member(ensemble_id, id) on delete cascade,
  foreign key (ensemble_id, event_id)  references public.event(ensemble_id, id)  on delete cascade
);
create index idx_attendance_event    on public.attendance (event_id);
create index idx_attendance_ensemble on public.attendance (ensemble_id);

-- RLS + grant, added after the schema-time blanket grant and the rls.sql policy loops.
-- Any member reads; a director records. Unlike availability (self-owned), attendance is a
-- record the director keeps, so writes are director-only.
grant select, insert, update, delete on public.attendance to authenticated;

alter table public.attendance enable row level security;

create policy attendance_read on public.attendance
  for select using (auth_member_tier(ensemble_id) is not null);

create policy attendance_write on public.attendance
  for all using (auth_member_tier(ensemble_id) = 'director')
          with check (auth_member_tier(ensemble_id) = 'director');


-- Stamp last_rehearsed for the songs actually run. Monotonic and idempotent (greatest),
-- so re-recording never moves a date backward and running it twice is a no-op. Explicit
-- director check (like perform_setlist): the song write policy is already director-only,
-- but with security invoker a non-director's UPDATE would silently touch zero rows, so
-- raise instead of a quiet no-op. p_date is frozen by the caller (the rehearsal date).
create or replace function mark_songs_rehearsed(p_ensemble uuid, p_songs uuid[], p_date date)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if public.auth_member_tier(p_ensemble) is distinct from 'director' then
    raise exception 'mark_songs_rehearsed: not authorized';
  end if;
  update public.song
     set last_rehearsed = greatest(last_rehearsed, p_date)
   where ensemble_id = p_ensemble and id = any(coalesce(p_songs, '{}'::uuid[]));
end;
$$;
revoke all on function mark_songs_rehearsed(uuid, uuid[], date) from public;
grant  execute on function mark_songs_rehearsed(uuid, uuid[], date) to authenticated;


-- Replace an event's attendance in one write: delete the old rows, insert the submitted
-- present/absent set. Director-write is enforced by RLS (security invoker), like
-- set_availability; no optimistic-concurrency token, since attendance is not co-edited the
-- way RSVP is (sharing the event.updated_at token would false-conflict against RSVP edits).
-- p_rows is a JSON array of {member_id, present}. Deduped by member (last write wins on a
-- repeat), so a malformed repeat can't trip the unique(member_id, event_id) constraint.
create or replace function save_attendance(p_event uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_ensemble uuid;
begin
  select ensemble_id into v_ensemble from public.event where id = p_event for update;
  if v_ensemble is null then return; end if;

  delete from public.attendance where ensemble_id = v_ensemble and event_id = p_event;
  insert into public.attendance (ensemble_id, member_id, event_id, present)
  select v_ensemble, d.member_id, p_event, d.present
  from (
    select distinct on ((att.value->>'member_id')::uuid)
           (att.value->>'member_id')::uuid as member_id,
           (att.value->>'present')::boolean as present
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as att(value, ordinality)
    order by (att.value->>'member_id')::uuid, att.ordinality desc
  ) d;
end;
$$;
revoke all on function save_attendance(uuid, jsonb) from public;
grant  execute on function save_attendance(uuid, jsonb) to authenticated;
