-- ============================================================================
-- Curated write RPCs the director calls.
--
-- Each of these replaces a sequence of PostgREST requests that used to autocommit one
-- statement at a time. A failure part way through left real corruption: a member with no
-- sections, a half-rewritten program, a song whose version advanced while its parts were
-- gone. Every write below runs inside one function, so one transaction, and any error rolls
-- the whole thing back.
--
-- All of them are SECURITY INVOKER. That is the point: RLS still scopes every touched row to
-- the caller's ensemble and tier, so these functions curate a multi-statement write without
-- widening anyone's reach. The three that need a tier check beyond what RLS gives
-- (perform_setlist, mark_songs_rehearsed) check auth_member_tier explicitly, because a
-- SECURITY INVOKER update that RLS filters out is a silent zero-row no-op, not an error.
--
-- Ordering inside this file: prune_member_coverage comes first because save_member calls it.
-- set_member_status, defined elsewhere, calls it too. PL/pgSQL does not resolve callees at
-- create time, so this is for the reader, not the parser.
--
-- Ordering against the other files: everything here depends on the tables in 001, the
-- auth helpers and grants in 002, and the guard triggers in 003. Two functions cooperate
-- with a guard from 003 through a transaction-local GUC (set_song_casting sets
-- app.casting_writer, perform_setlist sets app.perform_writer); those triggers must exist or
-- the vouching is a no-op that fails open in the wrong direction.
--
-- Search path is pinned to pg_catalog, pg_temp on every function here. Every table reference
-- in these bodies is schema-qualified, so nothing needs public on the path.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Members and coverage
-- ----------------------------------------------------------------------------

-- Drop a departing member's castings and RSVPs, then promote the strongest remaining cover to
-- lead on any part they led. Ranking is solid, then shaky, then learning (a null confidence
-- ranks as solid), then earliest cast, then lowest id as a deterministic final tiebreak.
--
-- Destructive and irreversible. The deletes carry no date predicate, so this removes the
-- member's entire casting and availability history, not just their future commitments.
-- Deactivating a member is not a soft toggle.
create or replace function public.prune_member_coverage(p_ensemble uuid, p_member uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_led uuid[];
begin
-- The parts this member led as primary; each may need a new primary once their rows are gone.
select array_agg(part_id) into v_led
from public.casting
where ensemble_id = p_ensemble and member_id = p_member and is_primary;

delete from public.casting     where ensemble_id = p_ensemble and member_id = p_member;
delete from public.availability where ensemble_id = p_ensemble and member_id = p_member;

if v_led is null then return; end if;

-- Promote one new primary per orphaned led part (no primary left after the delete), picking the
-- strongest confidence, then the earliest cast, then the lowest id. One statement replaces the loop.
with next_leads as (
    select distinct on (c.part_id) c.id
    from public.casting c
    where c.ensemble_id = p_ensemble
    and c.part_id = any(v_led)
    and not exists (
        select 1 from public.casting lead
        where lead.ensemble_id = p_ensemble
        and lead.part_id = c.part_id
        and lead.is_primary
    )
    order by
    c.part_id,
    case coalesce(c.self_reported_confidence, 'solid')
    when 'solid' then 0 when 'shaky' then 1 when 'learning' then 2 else 0 end,
    c.created_at,
    c.id
)
update public.casting c
set is_primary = true
from next_leads n
where c.id = n.id;
end;
$$;
revoke all on function public.prune_member_coverage(uuid, uuid) from public;
-- save_member and set_member_status are SECURITY INVOKER and call this as the authenticated
-- caller, so the caller needs EXECUTE; RLS on casting and availability still scopes every row.
grant execute on function public.prune_member_coverage(uuid, uuid) to authenticated;


-- Create or update a member and replace their section memberships. p_member null means create.
-- p_data carries the member columns in snake_case; p_sections is a jsonb array of
-- {voice_part_id, is_primary}. p_prune drops the member's coverage afterward, for a singer
-- going non-singing. Returns the member id, or null when an update matched nothing.
create or replace function public.save_member(
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
revoke all on function public.save_member(uuid, uuid, jsonb, jsonb, boolean) from public;
grant execute on function public.save_member(uuid, uuid, jsonb, jsonb, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- Songs, parts, and casting
-- ----------------------------------------------------------------------------

-- Create a song with its tags and parts in one transaction. Creating the song and its parts
-- separately could strand an active song with no parts, which the feasibility gate then reads
-- as trivially coverable. p_tags is an array of tag names; unknown names drop. p_parts is an
-- array of part objects, and sort_order comes from the array index, so the submitted visual
-- order is what persists. There is no reorder RPC: reorder the array and re-save.
create or replace function public.create_song(
    p_ensemble uuid,
    p_data     jsonb,
    p_tags     jsonb,
    p_parts    jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_song uuid;
v_part jsonb;
v_ord  bigint;
begin
insert into public.song
(ensemble_id, title, arranger, chart_ref, start_key_fifths, start_key_mode, end_key_fifths,
    end_key_mode, start_tempo_bpm, end_tempo_bpm, start_pitch, duration_seconds, is_explicit,
    uses_accompaniment, intensity, assessed_readiness, book_status, last_rehearsed)
values (
    p_ensemble,
    p_data->>'title', p_data->>'arranger', p_data->>'chart_ref',
    (p_data->>'start_key_fifths')::smallint, p_data->>'start_key_mode',
    (p_data->>'end_key_fifths')::smallint, p_data->>'end_key_mode',
    (p_data->>'start_tempo_bpm')::smallint, (p_data->>'end_tempo_bpm')::smallint,
    p_data->>'start_pitch', (p_data->>'duration_seconds')::integer,
    (p_data->>'is_explicit')::boolean, (p_data->>'uses_accompaniment')::boolean,
    (p_data->>'intensity')::smallint,
    p_data->>'assessed_readiness', p_data->>'book_status', (p_data->>'last_rehearsed')::date)
returning id into v_song;

insert into public.song_tag (ensemble_id, song_id, tag_id)
select distinct p_ensemble, v_song, t.id
from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) as submitted(tag_name)
join public.tag t on t.ensemble_id = p_ensemble and t.name = submitted.tag_name;

for v_part, v_ord in
select value, ordinality
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) with ordinality as t(value, ordinality)
loop
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high, sort_order)
values (
    p_ensemble, v_song,
    v_part->>'label', (v_part->>'is_required')::boolean, (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid, (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint, (v_part->>'range_high')::smallint,
    (v_ord - 1)::smallint);
end loop;

return jsonb_build_object('ok', true, 'id', v_song);
end;
$$;
revoke all on function public.create_song(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_song(uuid, jsonb, jsonb, jsonb) to authenticated;


-- Save a song, its tags, and its parts against an expected version. The claim, the tag rewrite,
-- and the part reconciliation are one transaction, so a constraint error rolls back the version
-- claim too. Without that, a failure after the claim left the title changed and the version
-- advanced while the parts were gone.
--
-- Returns {ok:true, version} or {ok:false, reason:'conflict'|'not_found'}. The version token is
-- song.updated_at, which moddatetime bumps on the claiming UPDATE.
create or replace function public.save_song(
    p_song     uuid,
    p_expected timestamptz,
    p_data     jsonb,
    p_tags     jsonb,
    p_parts    jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_version  timestamptz;
v_existing uuid[];
v_kept     uuid[];
v_seen     uuid[] := '{}';
v_part     jsonb;
v_ord      bigint;
v_pid      uuid;
begin
-- 1. Claim the song row on the expected version (moddatetime bumps updated_at, the new token).
update public.song set
title              = p_data->>'title',
arranger           = p_data->>'arranger',
chart_ref          = p_data->>'chart_ref',
start_key_fifths   = (p_data->>'start_key_fifths')::smallint,
start_key_mode     = p_data->>'start_key_mode',
end_key_fifths     = (p_data->>'end_key_fifths')::smallint,
end_key_mode       = p_data->>'end_key_mode',
start_tempo_bpm    = (p_data->>'start_tempo_bpm')::smallint,
end_tempo_bpm      = (p_data->>'end_tempo_bpm')::smallint,
start_pitch        = p_data->>'start_pitch',
duration_seconds   = (p_data->>'duration_seconds')::integer,
is_explicit        = (p_data->>'is_explicit')::boolean,
uses_accompaniment = (p_data->>'uses_accompaniment')::boolean,
intensity          = (p_data->>'intensity')::smallint,
assessed_readiness = p_data->>'assessed_readiness',
book_status        = p_data->>'book_status',
last_rehearsed     = (p_data->>'last_rehearsed')::date
where id = p_song and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_version;
if not found then
if exists (select 1 from public.song where id = p_song)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;

-- 2. Rewrite song_tag from the submitted names (resolved to tag ids in this ensemble; unknown
--    names are simply dropped, as the adapter did).
delete from public.song_tag where song_id = p_song;
insert into public.song_tag (ensemble_id, song_id, tag_id)
select distinct v_ensemble, p_song, t.id
from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) as submitted(tag_name)
join public.tag t on t.ensemble_id = v_ensemble and t.name = submitted.tag_name;

-- 3. Reconcile parts (mirror writeParts): keep ids that still name a part of this song (so
--    their castings survive), drop the rest (castings cascade via FK), update kept in place,
--    insert the new. A duplicate id updates once, then becomes an insert. sort_order comes
--    from the array index, so the submitted visual order is what persists.
select coalesce(array_agg(id), '{}') into v_existing from public.part where song_id = p_song;
select coalesce(array_agg(distinct (e->>'id')::uuid), '{}')
into v_kept
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) e
where nullif(e->>'id', '') is not null and (e->>'id')::uuid = any(v_existing);
delete from public.part where song_id = p_song and not (id = any(v_kept));

for v_part, v_ord in
select value, ordinality
from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) with ordinality as t(value, ordinality)
loop
v_pid := nullif(v_part->>'id', '')::uuid;
if v_pid is not null and v_pid = any(v_existing) and not (v_pid = any(v_seen)) then
v_seen := v_seen || v_pid;
update public.part set
label         = v_part->>'label',
is_required   = (v_part->>'is_required')::boolean,
count_needed  = (v_part->>'count_needed')::smallint,
voice_part_id = (v_part->>'voice_part_id')::uuid,
is_solo       = (v_part->>'is_solo')::boolean,
range_low     = (v_part->>'range_low')::smallint,
range_high    = (v_part->>'range_high')::smallint,
sort_order    = (v_ord - 1)::smallint
where id = v_pid;
else
insert into public.part
(ensemble_id, song_id, label, is_required, count_needed, voice_part_id, is_solo, range_low, range_high, sort_order)
values (
    v_ensemble, p_song,
    v_part->>'label',
    (v_part->>'is_required')::boolean,
    (v_part->>'count_needed')::smallint,
    (v_part->>'voice_part_id')::uuid,
    (v_part->>'is_solo')::boolean,
    (v_part->>'range_low')::smallint,
    (v_part->>'range_high')::smallint,
    (v_ord - 1)::smallint
);
end if;
end loop;

return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;
revoke all on function public.save_song(uuid, timestamptz, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_song(uuid, timestamptz, jsonb, jsonb, jsonb) to authenticated;


-- Replace a song's whole casting collection against an expected version. Parent claim and child
-- rewrite share the transaction, so the parent row lock taken by the guarded UPDATE is held
-- across the delete and insert: a concurrent same-token writer blocks, then sees the bumped
-- version and gets a conflict. Rows are [{ partId, memberId, isPrimary, directorAssessed }].
--
-- self_reported_confidence is the member's column, never the director's payload. It is read
-- back from the prior row and re-inserted. That re-insert is what app.casting_writer vouches
-- for: guard_casting_confidence (003) would otherwise null a non-self INSERT and wipe every
-- member's self-report on each director save. The flag is transaction-local, so it resets at
-- commit and never leaks to another pooled request.
--
-- learned_at keeps the prior date while a cover stays solid, stamps now when it newly becomes
-- solid, and is null otherwise.
create or replace function public.set_song_casting(p_song uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
v_prior    jsonb;
begin
-- Vouch for this function's preserved re-inserts so the confidence-owner trigger trusts them
-- (txn-local: resets at commit, never leaks to another request).
perform set_config('app.casting_writer', 'rpc', true);

update public.song set updated_at = now()
where id = p_song and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
if exists (select 1 from public.song where id = p_song)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;

-- Snapshot the prior castings for this song's parts BEFORE deleting, keyed by part:member.
select coalesce(
    jsonb_object_agg(
        c.part_id::text || ':' || c.member_id::text,
        jsonb_build_object('src', c.self_reported_confidence, 'da', c.director_assessed, 'la', c.learned_at)
    ),
    '{}'::jsonb)
into v_prior
from public.casting c
where c.part_id in (select id from public.part where song_id = p_song);

delete from public.casting
where part_id in (select id from public.part where song_id = p_song);

insert into public.casting (ensemble_id, part_id, member_id, is_primary, self_reported_confidence, director_assessed, learned_at)
select
v_ensemble,
(r->>'partId')::uuid,
(r->>'memberId')::uuid,
coalesce((r->>'isPrimary')::boolean, false),
p.src,
nullif(r->>'directorAssessed', '')::text,
case
when (r->>'directorAssessed') = 'solid'
then case when p.da = 'solid' then coalesce(p.la, now()) else now() end
else null
end
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
left join lateral (
    select
    v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'src'              as src,
    v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'da'               as da,
    (v_prior -> ((r->>'partId') || ':' || (r->>'memberId')) ->> 'la')::timestamptz as la
) p on true
where (r->>'partId')::uuid in (select id from public.part where song_id = p_song);

return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_song_casting(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_song_casting(uuid, timestamptz, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- Vocabulary ordering
-- ----------------------------------------------------------------------------

-- Total, collision-free reorder of a vocabulary table. A per-row UPDATE loop left a
-- half-renumbered list on any failure. The supplied ids lead, deduped and existing only, then
-- any omitted rows in their current order, renumbered 0..n-1.
--
-- p_table is whitelisted against a fixed list before it reaches format(), so it cannot be
-- turned into arbitrary SQL. The dynamic statement is the price of one function covering three
-- structurally identical tables.
create or replace function public.reorder_vocab(p_ensemble uuid, p_table text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $_$
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
$_$;
revoke all on function public.reorder_vocab(uuid, text, uuid[]) from public;
grant execute on function public.reorder_vocab(uuid, text, uuid[]) to authenticated;


-- ----------------------------------------------------------------------------
-- Events, event types, and availability
-- ----------------------------------------------------------------------------

-- Create or update an event type with its tag rules. p_exclude, p_prefer, and p_require are tag
-- NAMES, resolved to this ensemble's tag ids; unknown names drop. A tag named in more than one
-- list resolves exclude first, then require, then prefer. Returns the event-type id, or null
-- when an update matched nothing.
create or replace function public.save_event_type(
    p_ensemble uuid,
    p_type     uuid,
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
v_type uuid;
begin
if p_type is null then
insert into public.event_type
(ensemble_id, name, sort_order, padding_profile_id, default_allows_on_book,
    default_allows_explicit, default_allows_accompaniment)
values (
    p_ensemble, p_data->>'name', coalesce((p_data->>'sort_order')::smallint, 0),
    (p_data->>'padding_profile_id')::uuid,
    (p_data->>'default_allows_on_book')::boolean, (p_data->>'default_allows_explicit')::boolean,
    (p_data->>'default_allows_accompaniment')::boolean)
returning id into v_type;
else
update public.event_type set
name = p_data->>'name',
padding_profile_id = (p_data->>'padding_profile_id')::uuid,
default_allows_on_book = (p_data->>'default_allows_on_book')::boolean,
default_allows_explicit = (p_data->>'default_allows_explicit')::boolean,
default_allows_accompaniment = (p_data->>'default_allows_accompaniment')::boolean
where ensemble_id = p_ensemble and id = p_type;
if not found then return null; end if;
v_type := p_type;
end if;

delete from public.event_type_tag where ensemble_id = p_ensemble and event_type_id = v_type;
insert into public.event_type_tag (ensemble_id, event_type_id, tag_id, effect)
select p_ensemble, v_type, t.id,
case when t.name = any(coalesce(p_exclude, '{}')) then 'exclude'
when t.name = any(coalesce(p_require, '{}')) then 'require'
else 'prefer' end
from public.tag t
where t.ensemble_id = p_ensemble
and (t.name = any(coalesce(p_exclude, '{}'))
    or t.name = any(coalesce(p_require, '{}'))
    or t.name = any(coalesce(p_prefer, '{}')));
return v_type;
end;
$$;
revoke all on function public.save_event_type(uuid, uuid, jsonb, text[], text[], text[]) from public;
grant execute on function public.save_event_type(uuid, uuid, jsonb, text[], text[], text[]) to authenticated;


-- Create or update an event with its tag rules, and on create seed a gig's Main-set setlist.
-- p_data carries the event columns in snake_case, including kind and max_duration_seconds, which
-- ride in the payload rather than as arguments. Tag rules resolve the same three ways as
-- save_event_type. Returns the event id, or null when an update matched nothing.
--
-- No availability is seeded on create. A fabricated 'in' forges a confirmation the member never
-- gave, and the director then cannot tell "saw it and confirmed" from "has no idea it exists".
-- Members start with no row, meaning pending, until they RSVP. Nothing real is lost: the drafter
-- counts a member as available only on an explicit 'in' or 'tentative', so a fresh gig with no
-- RSVPs simply drafts nothing until singers respond.
create or replace function public.save_event(
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
revoke all on function public.save_event(uuid, uuid, jsonb, text[], text[], text[]) from public;
grant execute on function public.save_event(uuid, uuid, jsonb, text[], text[], text[]) to authenticated;


-- Replace an event's whole availability collection against an expected version, the director
-- editing RSVPs on everyone's behalf. Rows are [{ memberId, status }]. Same claim-then-rewrite
-- shape as set_song_casting: the guarded UPDATE takes the event row lock, the delete and insert
-- run under it, and a stale token yields a conflict without touching a child row. The RETURNING
-- updated_at is the fresh token handed back.
create or replace function public.set_availability(p_event uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
begin
update public.event set updated_at = now()
where id = p_event and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
if exists (select 1 from public.event where id = p_event)
then return jsonb_build_object('ok', false, 'reason', 'conflict');
else return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
end if;
delete from public.availability where event_id = p_event;
insert into public.availability (ensemble_id, member_id, event_id, status)
select v_ensemble, (r->>'memberId')::uuid, p_event, r->>'status'
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_availability(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_availability(uuid, timestamptz, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- Programs (the playground)
-- ----------------------------------------------------------------------------

-- Replace a program's name, when given, and its ordered items. This was a name update plus a
-- delete-then-insert across three requests, so a failure could rename without reordering, or
-- wipe the program on a failed insert. p_name null leaves the name alone; p_song_ids is the
-- order; p_open and p_close pin the ends.
create or replace function public.save_program(p_program uuid, p_name text, p_song_ids uuid[], p_open uuid, p_close uuid)
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
revoke all on function public.save_program(uuid, text, uuid[], uuid, uuid) from public;
grant execute on function public.save_program(uuid, text, uuid[], uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Setlists
-- ----------------------------------------------------------------------------

-- Assign a playground program to an event as a fresh draft setlist. Creating the setlist and
-- then setting its pins in two requests could strand a pin-less setlist on the event. One
-- transaction: create the draft, copy the program's order as open/close/keep pins. Returns the
-- new setlist id, or null when the program or event is not visible.
create or replace function public.create_setlist_from_program(p_ensemble uuid, p_program uuid, p_event uuid)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_name  text;
v_new   uuid;
v_open  uuid;
v_close uuid;
begin
select name into v_name from public.program where ensemble_id = p_ensemble and id = p_program;
if v_name is null then return null; end if;
if not exists (select 1 from public.event where ensemble_id = p_ensemble and id = p_event) then
return null;
end if;

select song_id into v_open  from public.program_item
where ensemble_id = p_ensemble and program_id = p_program and pin = 'open'  limit 1;
select song_id into v_close from public.program_item
where ensemble_id = p_ensemble and program_id = p_program and pin = 'close' limit 1;
if v_close is not distinct from v_open then v_close := null; end if;

insert into public.setlist (ensemble_id, event_id, program_id, name, status)
values (p_ensemble, p_event, p_program, v_name, 'draft')
returning id into v_new;

insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, position)
select p_ensemble, v_new, pi.song_id,
case when pi.song_id = v_open then 'open' when pi.song_id = v_close then 'close' else 'keep' end,
false, 0
from public.program_item pi
where pi.ensemble_id = p_ensemble and pi.program_id = p_program;
return v_new;
end;
$$;
revoke all on function public.create_setlist_from_program(uuid, uuid, uuid) from public;
grant execute on function public.create_setlist_from_program(uuid, uuid, uuid) to authenticated;


-- Clone a performed setlist onto a target event as a fresh draft, copying its non-excluded order
-- as open/close/keep pins. One transaction, where this used to be an insert plus a separate
-- set_pins call. Returns the new setlist id, or null when the source is not a performed set in
-- this ensemble or the target event is missing.
create or replace function public.clone_setlist(p_ensemble uuid, p_source uuid, p_target_event uuid)
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
revoke all on function public.clone_setlist(uuid, uuid, uuid) from public;
grant execute on function public.clone_setlist(uuid, uuid, uuid) to authenticated;


-- Replace a draft's pins and exclusions, preserving each song's note and segue. A row is kept
-- only if it is excluded, pinned, or carries a note or segue. The old delete-then-insert across
-- two requests committed the delete first, so a failing insert (a pinned song since deleted, so
-- an FK violation) wiped every note, segue, and pin.
--
-- The draft assertion is defense in depth. The routes reject a locked set before calling, and
-- the performed-child triggers in 003 block writes to a performed set, but a 'final' set has no
-- trigger-level guard, so a direct PostgREST call could edit a set the app considers locked.
-- No tenant or role boundary is at stake here; this is record integrity.
create or replace function public.set_pins(
    p_setlist  uuid,
    p_open     uuid,
    p_close    uuid,
    p_keep     uuid[],
    p_excluded uuid[]
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
begin
select ensemble_id, status into v_ensemble, v_status from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;  -- not found / not visible
if v_status <> 'draft' then
raise exception 'set_pins: setlist is not a draft' using errcode = '55000';
end if;

-- Snapshot the existing notes + segues before clearing the items.
create temp table _pin_meta on commit drop as
select song_id, note, transition_seconds
from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist;

delete from public.setlist_item where ensemble_id = v_ensemble and setlist_id = p_setlist;

insert into public.setlist_item (ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
with src as (
    select distinct u.song_id
    from (
        select unnest(coalesce(array_remove(array[p_open, p_close] || coalesce(p_keep, '{}'::uuid[]), null), '{}'::uuid[])) as song_id
        union
        select unnest(coalesce(p_excluded, '{}'::uuid[]))
        union
        select song_id from _pin_meta
    ) u
)
select
v_ensemble, p_setlist, s.song_id,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null
when s.song_id = p_open  then 'open'
when s.song_id = p_close then 'close'
when s.song_id = any(coalesce(p_keep, '{}'::uuid[])) then 'keep'
else null end,
s.song_id = any(coalesce(p_excluded, '{}'::uuid[])),
m.note, m.transition_seconds,
case when s.song_id = any(coalesce(p_excluded, '{}'::uuid[])) then null else 0 end
from src s
left join _pin_meta m on m.song_id = s.song_id
where s.song_id = any(coalesce(p_excluded, '{}'::uuid[]))
or s.song_id = p_open
or s.song_id = p_close
or s.song_id = any(coalesce(p_keep, '{}'::uuid[]))
or m.note is not null
or m.transition_seconds is not null;
end;
$$;
revoke all on function public.set_pins(uuid, uuid, uuid, uuid[], uuid[]) from public;
grant execute on function public.set_pins(uuid, uuid, uuid, uuid[], uuid[]) to authenticated;


-- Set one field, note or segue, on a draft's setlist_item, preserving the rest, and drop the row
-- when nothing is left to anchor it. The route used to read-modify-upsert the whole row, so two
-- concurrent edits to different fields of the same song clobbered each other. The FOR UPDATE row
-- lock plus a single-field merge serializes them. Same draft assertion as set_pins.
create or replace function public.set_item_field(p_setlist uuid, p_song uuid, p_field text, p_note text, p_seconds int)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_cur      public.setlist_item%rowtype;
v_note     text;
v_seconds  int;
v_excluded boolean;
v_pin      text;
v_position smallint;
begin
if p_field not in ('note', 'transition') then
raise exception 'set_item_field: unknown field %', p_field;
end if;

select ensemble_id, status into v_ensemble, v_status from public.setlist where id = p_setlist for update;
if v_ensemble is null then return; end if;
if v_status <> 'draft' then
raise exception 'set_item_field: setlist is not a draft' using errcode = '55000';
end if;

select * into v_cur from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song
for update;

v_excluded := coalesce(v_cur.is_excluded, false);
v_pin      := v_cur.pin;
v_note     := case when p_field = 'note' then nullif(p_note, '') else v_cur.note end;
v_seconds  := case when p_field = 'transition' then p_seconds else v_cur.transition_seconds end;

-- No remaining reason to exist (no pin, not excluded, no note, no segue): drop the row.
if v_pin is null and not v_excluded and v_note is null and v_seconds is null then
delete from public.setlist_item
where ensemble_id = v_ensemble and setlist_id = p_setlist and song_id = p_song;
return;
end if;

-- The CHECK requires an excluded row to have null pin + null position, and a non-excluded row to
-- have a position; draft rows use the filler 0.
v_position := case when v_excluded then null else coalesce(v_cur.position, 0) end;
insert into public.setlist_item
(ensemble_id, setlist_id, song_id, pin, is_excluded, note, transition_seconds, position)
values (
    v_ensemble, p_setlist, p_song,
    case when v_excluded then null else v_pin end, v_excluded, v_note, v_seconds, v_position)
on conflict (setlist_id, song_id) do update set
note = excluded.note,
transition_seconds = excluded.transition_seconds;
end;
$$;
revoke all on function public.set_item_field(uuid, uuid, text, text, int) from public;
grant execute on function public.set_item_field(uuid, uuid, text, text, int) to authenticated;


-- Replace a draft's breaks against an expected version. Rows are
-- [{ label, durationSeconds, afterPosition }].
--
-- The draft check runs under the row lock BEFORE the optimistic updated_at bump, so a non-draft
-- is rejected without a side effect. Holding that lock also lets the post-update "not found"
-- mean only a version mismatch, since the row provably exists, so it maps to a clean conflict.
create or replace function public.set_breaks(p_setlist uuid, p_expected timestamptz, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_new      timestamptz;
v_status   text;
begin
select status into v_status from public.setlist where id = p_setlist for update;
if v_status is null then
return jsonb_build_object('ok', false, 'reason', 'not_found');
end if;
if v_status <> 'draft' then
raise exception 'set_breaks: setlist is not a draft' using errcode = '55000';
end if;

update public.setlist set updated_at = now()
where id = p_setlist and updated_at = p_expected
returning ensemble_id, updated_at into v_ensemble, v_new;
if not found then
return jsonb_build_object('ok', false, 'reason', 'conflict');
end if;
delete from public.setlist_break where setlist_id = p_setlist;
insert into public.setlist_break (ensemble_id, setlist_id, label, duration_seconds, after_position)
select v_ensemble, p_setlist, r->>'label', (r->>'durationSeconds')::integer, (r->>'afterPosition')::smallint
from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
return jsonb_build_object('ok', true, 'version', v_new);
end;
$$;
revoke all on function public.set_breaks(uuid, timestamptz, jsonb) from public;
grant execute on function public.set_breaks(uuid, timestamptz, jsonb) to authenticated;


-- Freeze a draft as performed: write the final order, the soloist credits, the performed date,
-- and the snapshot, then stamp last_performed on every song in it.
--
-- The snapshot MUST be written in the same UPDATE that flips status. setlist_immutable_guard
-- (003) raises on any update to an already-performed row, so a second UPDATE from the caller
-- never lands. At this statement old.status is still 'draft' and app.perform_writer vouches for
-- it, so the guard passes. p_snapshot may be null from an older client; reads then fall back to
-- live, which is safe.
--
-- The order is deduped on first occurrence and then capped at 512, so a duplicate cannot bump a
-- song to a stale position. An input over 2048 is rejected rather than truncated: a caller
-- sending more than the bound learns the order was refused instead of receiving a success for a
-- partially saved set. The tier check is explicit because a SECURITY INVOKER update that RLS
-- filters out would be a silent no-op.
--
-- The date is the event's own date, falling back to today in the ensemble's timezone, not the
-- server's.
create or replace function public.perform_setlist(p_setlist uuid, p_order uuid[], p_snapshot jsonb)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_status   text;
v_date     date;
v_order    uuid[];
begin
perform set_config('app.perform_writer', 'rpc', true);
-- Reject rather than silently truncate: a caller sending more than the bound learns the order was
-- refused instead of receiving a success for a partially-saved set.
if array_length(p_order, 1) > 2048 then
raise exception 'perform_setlist: order too large (% items); max 2048', array_length(p_order, 1)
using errcode = '22023';
end if;

select s.ensemble_id, s.status,
coalesce(
    e.event_date,
    (now() at time zone
        coalesce((select n.name from pg_timezone_names n where n.name = en.timezone), 'UTC')
    )::date)
into v_ensemble, v_status, v_date
from public.setlist s
join public.event e on e.ensemble_id = s.ensemble_id and e.id = s.event_id
join public.ensemble en on en.id = s.ensemble_id
where s.id = p_setlist
for update of s;

if v_ensemble is null then return false; end if;
if v_status = 'performed' then return false; end if;
if p_order is null or array_length(p_order, 1) is null then return false; end if;
if public.auth_member_tier(v_ensemble) is distinct from 'director' then return false; end if;

v_order := (
    select array_agg(song_id order by first_ord)
    from (
        select song_id, min(ord) as first_ord
        from unnest(p_order) with ordinality as u(song_id, ord)
        group by song_id
    ) d
);
v_order := v_order[1:512];

insert into public.setlist_item (ensemble_id, setlist_id, song_id, position, is_excluded, pin)
select v_ensemble, p_setlist, s.song_id, s.rn::int, false, null
from unnest(v_order) with ordinality as s(song_id, rn)
on conflict (setlist_id, song_id)
do update set position = excluded.position, is_excluded = false, pin = null;

delete from public.setlist_item
where setlist_id = p_setlist and not (song_id = any(v_order));

insert into public.performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select v_ensemble, p_setlist, p.song_id, p.id, c.member_id,
sg.title, coalesce(p.label, 'Solo'), m.display_name
from public.part p
join public.song    sg on sg.id = p.song_id
join public.casting c  on c.part_id = p.id and c.is_primary
join public.member  m  on m.id = c.member_id
where p.ensemble_id = v_ensemble and p.is_solo and p.song_id = any(v_order)
on conflict (setlist_id, part_id) do nothing;

-- Freeze status + date + the song/event snapshot in one UPDATE while the row is still 'draft', so
-- setlist_immutable_guard vouches for it. p_snapshot may be null (an older client); reads then fall
-- back to live, so a null is safe.
update public.setlist
set status = 'performed', performed_date = v_date, performed_snapshot = p_snapshot
where id = p_setlist;
update public.song set last_performed = greatest(last_performed, v_date)
where ensemble_id = v_ensemble and id = any(v_order);
return true;
end;
$$;
revoke all on function public.perform_setlist(uuid, uuid[], jsonb) from public;
grant execute on function public.perform_setlist(uuid, uuid[], jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- Rehearsals and prep
-- ----------------------------------------------------------------------------

-- Replace a rehearsal's agenda: delete the old items, insert the new ones in array order.
-- p_items is a jsonb array of {song_id, reason, note}. Director-write is enforced by RLS; the
-- event row lock scopes the tenant.
--
-- kind is guarded so a gig can never acquire an agenda. A gig's plan is its setlist.
--
-- Items are deduped by song, keeping the first occurrence, then re-ranked to gapless positions.
-- The unique(event_id, song_id) constraint is the backstop; deduping here matches the mock and
-- the route so a repeated song never aborts the whole write.
create or replace function public.save_rehearsal_agenda(p_event uuid, p_items jsonb)
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
revoke all on function public.save_rehearsal_agenda(uuid, jsonb) from public;
grant execute on function public.save_rehearsal_agenda(uuid, jsonb) to authenticated;


-- Record who actually came to a rehearsal, which is distinct from RSVP intent. availability
-- answers "who plans to come"; attendance answers "who showed". Replace the whole set in one
-- write. p_rows is a jsonb array of {member_id, present}, deduped by member with the last
-- occurrence winning, so a malformed repeat cannot trip the unique constraint.
--
-- No optimistic-concurrency token. Attendance is not co-edited the way RSVP is, and sharing
-- event.updated_at would false-conflict against RSVP edits.
--
-- kind is guarded. Attendance is reached only through the rehearsal-only record route, but
-- without this a director could call the RPC directly for a gig and persist rows the UI never
-- intends.
create or replace function public.save_attendance(p_event uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_ensemble uuid;
v_kind     text;
begin
select ensemble_id, kind into v_ensemble, v_kind from public.event where id = p_event for update;
if v_ensemble is null then return; end if;
if v_kind is distinct from 'rehearsal' then
raise exception 'save_attendance: event % is not a rehearsal', p_event;
end if;

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
revoke all on function public.save_attendance(uuid, jsonb) from public;
grant execute on function public.save_attendance(uuid, jsonb) to authenticated;


-- Stamp last_rehearsed on the songs actually run, so the staleness signal stays current without
-- the director maintaining it by hand. Monotonic and idempotent via greatest(), so re-recording
-- never moves a date backward and running it twice is a no-op. The manual date field on the song
-- form stays as a hand override.
--
-- p_date is frozen by the caller (the rehearsal date), not now(). Recording a rehearsal days
-- later should stamp the day it happened.
--
-- The director check is explicit. The song write policy is already director-only, but under
-- SECURITY INVOKER a non-director's UPDATE would touch zero rows and report success.
create or replace function public.mark_songs_rehearsed(p_ensemble uuid, p_songs uuid[], p_date date)
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
revoke all on function public.mark_songs_rehearsed(uuid, uuid[], date) from public;
grant execute on function public.mark_songs_rehearsed(uuid, uuid[], date) to authenticated;


-- Replace a gig's prep-target set: delete the old, insert the submitted song ids. A prep target
-- is an explicit commitment to have a song ready for a given gig, and the gig's event_date is
-- the deadline.
--
-- kind is guarded the other way from the two above: only a gig acquires targets, because a
-- rehearsal is the preparation. Deduped by song here as well as by the unique constraint, so a
-- repeated id cannot abort the write.
create or replace function public.save_prep_targets(p_event uuid, p_song_ids uuid[])
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
revoke all on function public.save_prep_targets(uuid, uuid[]) from public;
grant execute on function public.save_prep_targets(uuid, uuid[]) to authenticated;
