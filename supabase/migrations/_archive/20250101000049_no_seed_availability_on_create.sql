-- Stop seeding an 'in' RSVP for every member when an event is created. A fabricated 'in' forges a
-- confirmation the member never gave: the director cannot tell "saw the event and confirmed" from
-- "has no idea it exists". Members now start with no availability row (pending) until they RSVP,
-- for gigs and rehearsals alike. Nothing real is lost: the drafter already counts a member as
-- available only with an explicit 'in' (or 'tentative'), so it reflects confirmed reality; a fresh
-- gig with no RSVPs simply drafts nothing until singers respond, and staffing-free early sketching
-- lives in the Playground. The gig Main-set setlist seed stays. Everything else in save_event is
-- unchanged from 20250101000036_event_kind; the only edit is dropping the availability insert.

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

-- On create, a gig gets an auto Main-set setlist so it has a set to fill; a rehearsal uses its
-- agenda instead. No availability is seeded (see the header): members are pending until they RSVP.
if p_event is null and coalesce(p_data->>'kind', 'gig') = 'gig' then
insert into public.setlist (ensemble_id, event_id, name, status)
values (p_ensemble, v_event, 'Main set', 'draft');
end if;
return v_event;
end;
$$;
