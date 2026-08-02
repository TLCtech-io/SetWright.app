-- Rehearsal planner, phase R1: the event.kind discriminator.
--
-- A rehearsal is an event of kind 'rehearsal' (Option C in the design doc), reusing
-- the whole event + availability + RSVP machinery. kind defaults to 'gig', so every
-- existing event and all read paths stay gig-only unless they opt in. kind is set at
-- create and is not edited afterwards (a gig stays a gig).
--
-- kind is a calendar/list discriminator, not a drafter signal: the hydration and the
-- funnel never read it. The web filters the gig seams; the drafter is untouched.

alter table public.event
add column kind text not null default 'gig'
check (kind in ('gig', 'rehearsal'));


-- save_event: persist kind on create (immutable after), and skip the auto Main-set
-- setlist for a rehearsal (a rehearsal has an agenda in R2, not a gig set). Full
-- re-declaration of the …034 body; the 6-arg signature is unchanged (kind rides in
-- p_data), so this is a plain create-or-replace, no drop.
create or replace function save_event(
    p_ensemble uuid,
    p_event    uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[],
    p_require  text[]
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_event uuid;
begin
if p_event is null then
insert into public.event
(ensemble_id, name, venue, status, kind, event_type_id, event_date, target_duration_seconds,
    max_duration_seconds, allows_on_book, allows_explicit, allows_accompaniment,
    per_song_seconds, per_set_seconds)
values (
    p_ensemble, p_data->>'name', p_data->>'venue', p_data->>'status',
    coalesce(p_data->>'kind', 'gig'),
    (p_data->>'event_type_id')::uuid,
    (p_data->>'event_date')::date, (p_data->>'target_duration_seconds')::integer,
    (p_data->>'max_duration_seconds')::integer,
    (p_data->>'allows_on_book')::boolean, (p_data->>'allows_explicit')::boolean,
    (p_data->>'allows_accompaniment')::boolean,
    (p_data->>'per_song_seconds')::integer, (p_data->>'per_set_seconds')::integer)
returning id into v_event;
else
-- kind is intentionally not updated here: it is fixed at create.
update public.event set
name = p_data->>'name', venue = p_data->>'venue', status = p_data->>'status',
event_type_id = (p_data->>'event_type_id')::uuid, event_date = (p_data->>'event_date')::date,
target_duration_seconds = (p_data->>'target_duration_seconds')::integer,
max_duration_seconds = (p_data->>'max_duration_seconds')::integer,
allows_on_book = (p_data->>'allows_on_book')::boolean,
allows_explicit = (p_data->>'allows_explicit')::boolean,
allows_accompaniment = (p_data->>'allows_accompaniment')::boolean,
per_song_seconds = (p_data->>'per_song_seconds')::integer,
per_set_seconds = (p_data->>'per_set_seconds')::integer
where ensemble_id = p_ensemble and id = p_event;
if not found then return null; end if;
v_event := p_event;
end if;

-- Tag rules: exclude wins, then require, then prefer. Resolve names to the ensemble's
-- tags; unknown names drop.
delete from public.event_tag where ensemble_id = p_ensemble and event_id = v_event;
insert into public.event_tag (ensemble_id, event_id, tag_id, effect)
select p_ensemble, v_event, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude'
when t.name = any(coalesce(p_require, '{}')) then 'require'
else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}'))
    or t.name = any(coalesce(p_require, '{}'))
    or t.name = any(coalesce(p_prefer, '{}')));

if p_event is null then
-- Both kinds get a full RSVP roster (members RSVP to rehearsals too).
insert into public.availability (ensemble_id, member_id, event_id, status)
select p_ensemble, m.id, v_event, 'in'
from public.member m
where m.ensemble_id = p_ensemble and m.status = 'active' and m.is_singing;

-- Only a gig gets an auto Main-set setlist; a rehearsal uses its agenda (R2).
if coalesce(p_data->>'kind', 'gig') = 'gig' then
insert into public.setlist (ensemble_id, event_id, name, status)
values (p_ensemble, v_event, 'Main set', 'draft');
end if;
end if;
return v_event;
end;
$$;
revoke all on function save_event(uuid, uuid, jsonb, text[], text[], text[]) from public;
grant  execute on function save_event(uuid, uuid, jsonb, text[], text[], text[]) to authenticated;


-- kind is immutable at the DB boundary, not just in save_event's UPDATE branch. A
-- director holds a table-level UPDATE grant, so a direct PostgREST write bypasses the
-- RPC; flipping a gig to a rehearsal would orphan its setlist and performed history,
-- and the reverse would leave a gig with no set. Guard it with a trigger, matching how
-- the codebase enforces its other immutability guarantees (the performed-child guards).
create or replace function guard_event_kind_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
if new.kind is distinct from old.kind then
raise exception 'event.kind is immutable (was %, got %)', old.kind, new.kind;
end if;
return new;
end;
$$;

create trigger event_kind_immutable
before update on public.event
for each row execute function guard_event_kind_immutable();
