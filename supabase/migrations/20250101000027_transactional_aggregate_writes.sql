-- Make the remaining aggregate writes transactional (#5). Each ran as several PostgREST requests
-- (autocommitted), so a failure mid-sequence left corruption: a member with no sections, a ghost
-- event with no setlist, a half-rewritten program, dangling tag rules, an inconsistent reorder.
-- Every write below now runs in one SECURITY INVOKER function (one transaction), so RLS still
-- scopes each touched row to the caller and any error rolls the whole thing back. The pre-checks
-- that return typed results (last-director, not-found) stay in the adapter; only the multi-statement
-- WRITE moves here.

-- Promote the strongest remaining cover to lead on any part a departing member led, after dropping
-- their castings + RSVPs. Mirrors the adapter's pruneMemberCoverage (solid < shaky < learning; a
-- null confidence ranks as solid). Internal helper, shared by save_member and set_member_status.
create or replace function prune_member_coverage(p_ensemble uuid, p_member uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_led   uuid[];
v_part  uuid;
v_best  uuid;
begin
select array_agg(part_id) into v_led
from public.casting
where ensemble_id = p_ensemble and member_id = p_member and is_primary;

delete from public.casting     where ensemble_id = p_ensemble and member_id = p_member;
delete from public.availability where ensemble_id = p_ensemble and member_id = p_member;

if v_led is null then return; end if;
foreach v_part in array v_led loop
if exists (select 1 from public.casting
    where ensemble_id = p_ensemble and part_id = v_part and is_primary) then
continue; -- a primary still covers this part
end if;
select id into v_best
from public.casting
where ensemble_id = p_ensemble and part_id = v_part
order by case coalesce(self_reported_confidence, 'solid')
when 'solid' then 0 when 'shaky' then 1 when 'learning' then 2 else 0 end,
created_at
limit 1;
if v_best is not null then
update public.casting set is_primary = true
where ensemble_id = p_ensemble and id = v_best;
end if;
end loop;
end;
$$;
revoke all on function prune_member_coverage(uuid, uuid) from public;
-- save_member / set_member_status are SECURITY INVOKER and call this as the authenticated caller,
-- so the caller needs EXECUTE; RLS on casting/availability still scopes every row it touches.
grant execute on function prune_member_coverage(uuid, uuid) to authenticated;

-- Create or update a member and replace their section memberships atomically. p_member null =
-- create. p_data carries the member columns (snake_case); p_sections a jsonb array of
-- {voice_part_id, is_primary}. p_prune drops the member's coverage afterward (a singer going
-- non-singing/inactive). Returns the member id, or null when an update matched nothing.
create or replace function save_member(
    p_ensemble uuid,
    p_member   uuid,
    p_data     jsonb,
    p_sections jsonb,
    p_prune    boolean
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_member uuid;
begin
if p_member is null then
insert into public.member
(ensemble_id, display_name, permission_tier, is_singing, vocal_range_low, vocal_range_high, status)
values (
    p_ensemble, p_data->>'display_name', p_data->>'permission_tier',
    (p_data->>'is_singing')::boolean,
    (p_data->>'vocal_range_low')::smallint, (p_data->>'vocal_range_high')::smallint, 'active')
returning id into v_member;
else
update public.member set
display_name     = p_data->>'display_name',
permission_tier  = p_data->>'permission_tier',
is_singing       = (p_data->>'is_singing')::boolean,
vocal_range_low  = (p_data->>'vocal_range_low')::smallint,
vocal_range_high = (p_data->>'vocal_range_high')::smallint
where ensemble_id = p_ensemble and id = p_member;
if not found then return null; end if;
v_member := p_member;
end if;

delete from public.member_voice_part where ensemble_id = p_ensemble and member_id = v_member;
insert into public.member_voice_part (ensemble_id, member_id, voice_part_id, is_primary_section)
select p_ensemble, v_member, (s->>'voice_part_id')::uuid, (s->>'is_primary')::boolean
from jsonb_array_elements(coalesce(p_sections, '[]'::jsonb)) as s;

if p_prune then perform public.prune_member_coverage(p_ensemble, v_member); end if;
return v_member;
end;
$$;
revoke all on function save_member(uuid, uuid, jsonb, jsonb, boolean) from public;
grant  execute on function save_member(uuid, uuid, jsonb, jsonb, boolean) to authenticated;

-- Set a member's status and, when deactivating, prune their coverage — atomically.
create or replace function set_member_status(p_ensemble uuid, p_member uuid, p_status text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
update public.member set status = p_status where ensemble_id = p_ensemble and id = p_member;
if not found then return false; end if;
if p_status = 'inactive' then perform public.prune_member_coverage(p_ensemble, p_member); end if;
return true;
end;
$$;
revoke all on function set_member_status(uuid, uuid, text) from public;
grant  execute on function set_member_status(uuid, uuid, text) to authenticated;

-- Replace a program's name (when given) and ordered items atomically (was a name update plus a
-- delete-then-insert across three requests, so a failure could rename without reordering, or wipe
-- the program on a failed insert). p_name null = leave the name; p_song_ids in order; p_open/p_close
-- pin the ends.
create or replace function save_program(p_program uuid, p_name text, p_song_ids uuid[], p_open uuid, p_close uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
begin
select ensemble_id into v_ensemble from public.program where id = p_program for update;
if v_ensemble is null then return; end if;

if p_name is not null then
update public.program set name = p_name where ensemble_id = v_ensemble and id = p_program;
end if;

delete from public.program_item where ensemble_id = v_ensemble and program_id = p_program;
insert into public.program_item (ensemble_id, program_id, song_id, position, pin)
select v_ensemble, p_program, s.song_id, (s.rn - 1)::smallint,
case when s.song_id = p_open then 'open' when s.song_id = p_close then 'close' else null end
from unnest(coalesce(p_song_ids, '{}'::uuid[])) with ordinality as s(song_id, rn);
end;
$$;
revoke all on function save_program(uuid, text, uuid[], uuid, uuid) from public;
grant  execute on function save_program(uuid, text, uuid[], uuid, uuid) to authenticated;

-- Create or update an event with its tag rules, and on create seed the availability pool + a
-- setlist — atomically. p_data carries the event columns (snake_case). p_exclude/p_prefer are tag
-- NAMES (resolved to ids in the ensemble; exclude wins over prefer). Returns the event id, or null
-- when an update matched nothing.
create or replace function save_event(
    p_ensemble uuid,
    p_event    uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[]
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
(ensemble_id, name, venue, status, event_type_id, event_date, target_duration_seconds,
    allows_on_book, allows_explicit, per_song_seconds, per_set_seconds)
values (
    p_ensemble, p_data->>'name', p_data->>'venue', p_data->>'status', (p_data->>'event_type_id')::uuid,
    (p_data->>'event_date')::date, (p_data->>'target_duration_seconds')::integer,
    (p_data->>'allows_on_book')::boolean, (p_data->>'allows_explicit')::boolean,
    (p_data->>'per_song_seconds')::integer, (p_data->>'per_set_seconds')::integer)
returning id into v_event;
else
update public.event set
name = p_data->>'name', venue = p_data->>'venue', status = p_data->>'status',
event_type_id = (p_data->>'event_type_id')::uuid, event_date = (p_data->>'event_date')::date,
target_duration_seconds = (p_data->>'target_duration_seconds')::integer,
allows_on_book = (p_data->>'allows_on_book')::boolean,
allows_explicit = (p_data->>'allows_explicit')::boolean,
per_song_seconds = (p_data->>'per_song_seconds')::integer,
per_set_seconds = (p_data->>'per_set_seconds')::integer
where ensemble_id = p_ensemble and id = p_event;
if not found then return null; end if;
v_event := p_event;
end if;

-- Tag rules: exclude wins over prefer. Resolve names to the ensemble's tags; unknown names drop.
delete from public.event_tag where ensemble_id = p_ensemble and event_id = v_event;
insert into public.event_tag (ensemble_id, event_id, tag_id, effect)
select p_ensemble, v_event, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude' else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}')) or t.name = any(coalesce(p_prefer, '{}')));

if p_event is null then
insert into public.availability (ensemble_id, member_id, event_id, status)
select p_ensemble, m.id, v_event, 'in'
from public.member m
where m.ensemble_id = p_ensemble and m.status = 'active' and m.is_singing;

insert into public.setlist (ensemble_id, event_id, name, status)
values (p_ensemble, v_event, 'Main set', 'draft');
end if;
return v_event;
end;
$$;
revoke all on function save_event(uuid, uuid, jsonb, text[], text[]) from public;
grant  execute on function save_event(uuid, uuid, jsonb, text[], text[]) to authenticated;

-- Create or update an event TYPE with its prefer/exclude tag rules atomically. Same exclude-wins
-- resolution as save_event, on event_type_tag. Returns the event-type id, null on a missed update.
create or replace function save_event_type(
    p_ensemble uuid,
    p_type     uuid,
    p_data     jsonb,
    p_exclude  text[],
    p_prefer   text[]
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_type uuid;
begin
if p_type is null then
insert into public.event_type
(ensemble_id, name, sort_order, padding_profile_id, default_allows_on_book, default_allows_explicit)
values (
    p_ensemble, p_data->>'name', coalesce((p_data->>'sort_order')::smallint, 0),
    (p_data->>'padding_profile_id')::uuid,
    (p_data->>'default_allows_on_book')::boolean, (p_data->>'default_allows_explicit')::boolean)
returning id into v_type;
else
update public.event_type set
name = p_data->>'name',
padding_profile_id = (p_data->>'padding_profile_id')::uuid,
default_allows_on_book = (p_data->>'default_allows_on_book')::boolean,
default_allows_explicit = (p_data->>'default_allows_explicit')::boolean
where ensemble_id = p_ensemble and id = p_type;
if not found then return null; end if;
v_type := p_type;
end if;

delete from public.event_type_tag where ensemble_id = p_ensemble and event_type_id = v_type;
insert into public.event_type_tag (ensemble_id, event_type_id, tag_id, effect)
select p_ensemble, v_type, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude' else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}')) or t.name = any(coalesce(p_prefer, '{}')));
return v_type;
end;
$$;
revoke all on function save_event_type(uuid, uuid, jsonb, text[], text[]) from public;
grant  execute on function save_event_type(uuid, uuid, jsonb, text[], text[]) to authenticated;

-- Total, collision-free reorder of a vocabulary table, atomically (was a per-row UPDATE loop, so a
-- failure left a half-renumbered list). The supplied ids first (deduped, existing only), then any
-- omitted rows in their current order, renumbered 0..n-1. p_table is whitelisted, not interpolated
-- blindly, so it cannot be turned into arbitrary SQL.
create or replace function reorder_vocab(p_ensemble uuid, p_table text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_sql text;
begin
if p_table not in ('voice_part', 'event_type', 'tag') then
raise exception 'reorder_vocab: unsupported table %', p_table;
end if;
-- The supplied ids lead (deduped, first occurrence, existing only); omitted rows follow in their
-- current sort_order; renumber 0..n-1. p_table is whitelisted above, so %I quoting is safe.
v_sql := format($q$
    with supplied as (
        select distinct on (u.id) u.id, u.rn
        from unnest($1) with ordinality as u(id, rn)
        where exists (select 1 from public.%1$I t where t.ensemble_id = $2 and t.id = u.id)
        order by u.id, u.rn
    ),
    ranked as (
        select t.id,
        coalesce((select s.rn from supplied s where s.id = t.id), 1000000 + t.sort_order) as ord
        from public.%1$I t
        where t.ensemble_id = $2
    ),
    final as (
        select id, (row_number() over (order by ord, id) - 1)::smallint as pos from ranked
    )
    update public.%1$I t set sort_order = f.pos
    from final f where t.ensemble_id = $2 and t.id = f.id
    $q$, p_table);
execute v_sql using p_ids, p_ensemble;
end;
$$;
revoke all on function reorder_vocab(uuid, text, uuid[]) from public;
grant  execute on function reorder_vocab(uuid, text, uuid[]) to authenticated;

-- Clone a performed setlist onto a target event as a fresh draft, copying its (non-excluded) order
-- as open/close/keep pins — atomically (was an insert + a separate set_pins call). Returns the new
-- setlist id, or null when the source is not a performed set in this ensemble / the target is missing.
create or replace function clone_setlist(p_ensemble uuid, p_source uuid, p_target_event uuid)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_name   text;
v_status text;
v_new    uuid;
v_ids    uuid[];
v_open   uuid;
v_close  uuid;
begin
select name, status into v_name, v_status
from public.setlist where ensemble_id = p_ensemble and id = p_source;
if v_status is distinct from 'performed' then return null; end if;
if not exists (select 1 from public.event where ensemble_id = p_ensemble and id = p_target_event) then
return null;
end if;

select array_agg(song_id order by position) into v_ids
from public.setlist_item
where ensemble_id = p_ensemble and setlist_id = p_source and is_excluded = false;
v_ids := coalesce(v_ids, '{}'::uuid[]);

insert into public.setlist (ensemble_id, event_id, name, status)
values (p_ensemble, p_target_event,
    case when v_name is not null then v_name || ' (clone)' else 'Cloned set' end, 'draft')
returning id into v_new;

if array_length(v_ids, 1) is not null then
v_open  := v_ids[1];
v_close := case when array_length(v_ids, 1) > 1 then v_ids[array_length(v_ids, 1)] else null end;
insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, position)
select p_ensemble, v_new, s.song_id,
case when s.song_id = v_open then 'open'
when s.song_id = v_close then 'close' else 'keep' end,
false, 0
from (select distinct unnest(v_ids) as song_id) s;
end if;
return v_new;
end;
$$;
revoke all on function clone_setlist(uuid, uuid, uuid) from public;
grant  execute on function clone_setlist(uuid, uuid, uuid) to authenticated;
