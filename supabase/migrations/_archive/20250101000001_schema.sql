-- ============================================================================
-- Setlist drafting tool - PostgreSQL schema (compiled, canonical data model)
-- Target: PostgreSQL 13+ / Supabase.
--
-- Conventions
--   - Primary keys are uuid. gen_random_uuid() is the in-database default;
--     prefer generating uuid v7 in the application layer for index locality.
--   - All timestamps are timestamptz. created_at / updated_at on every table with
--     a lifecycle; updated_at is maintained by moddatetime triggers (near the end).
--   - Provenance: created_by / updated_by reference app_user, on delete set null,
--     so removing a user never breaks the audit trail. app_user, the identity
--     table, carries no provenance of its own.
--   - Multi-tenancy: every tenant-scoped table carries ensemble_id. Foreign keys
--     between tenant-scoped tables are composite and include ensemble_id, so the
--     database itself refuses a cross-tenant reference. Belt-and-suspenders with RLS.
--   - Fixed vocabularies (status, readiness, ...) are text + CHECK. Vocabularies
--     that vary per ensemble (voice parts, tags, event types) are their own tables.
--   - Pitch is stored as a MIDI integer, middle C = C4 = 60, shown as scientific
--     notation at the UI. Key is stored as a fifths value (-7..+7) plus mode.
--     Durations are stored in seconds. These conversions live in the app layer.
--   - Reserved-word renames: app_user (user), ensemble (group), setlist (set).
--
-- ON DELETE policy
--   - Child rows and link tables cascade from their owning parent.
--   - Optional config references (event->type, event->padding, type->padding) set null.
--   - A voice part cannot be deleted while a chart still calls for it (part->voice_part
--     is NO ACTION).
--   - Provenance sets null. References to ensemble are NO ACTION; retire a tenant with
--     status = 'archived' rather than deleting it.
--
-- Deliberately NOT here
--   - Row-level security policies. Enabling RLS without policies denies all access,
--     so it is a separate pass (member writes own, director writes all, isolation on
--     ensemble_id).
--   - The write that stamps song.last_performed when a setlist is marked performed.
--     That is application/trigger logic, not structure.
--   - Final index tuning. The indexes at the end are a sensible starting set.
--
-- app_user depends on Supabase's auth.users. Outside Supabase, point it at your own
-- identity table.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Identity (global) and tenant root
-- ----------------------------------------------------------------------------

-- One row per human, 1:1 with Supabase auth.users. The global identity.
create table app_user (
    id           uuid primary key references auth.users(id) on delete cascade,
    email        text,                          -- convenience mirror; auth is canonical
    display_name text,                          -- the person's own name
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- The tenant. Every tenant-scoped row references this.
create table ensemble (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    slug        text unique,                     -- future tenant-addressable routing
    timezone    text not null default 'America/New_York',  -- IANA; anchors date math
    status      text not null default 'active'
    check (status in ('active','suspended','archived')),
    -- Peer visibility of casting.self_reported_confidence. 'member_choice' arrives
    -- later with the per-member toggle; kept out of the check until then, to fail loud.
    confidence_visibility text not null default 'private'
    check (confidence_visibility in ('private','shared')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null
);


-- ----------------------------------------------------------------------------
-- People
-- ----------------------------------------------------------------------------

-- A singer within one ensemble. Membership + voice profile + role. user_id is null
-- until the person claims the seat.
create table member (
    id               uuid primary key default gen_random_uuid(),
    ensemble_id      uuid not null references ensemble(id),
    user_id          uuid references app_user(id) on delete set null,
    display_name     text not null,
    permission_tier  text not null default 'member'
    check (permission_tier in ('member','section_leader','director')),
    is_singing       boolean not null default true,  -- false = active member with platform
    -- access who is not pulled into the
    -- singing pool (conductor, manager)
    vocal_range_low  smallint,                   -- MIDI; advisory, not the coverage gate
    vocal_range_high smallint,                   -- MIDI
    status           text not null default 'active'
    check (status in ('active','inactive')),  -- 'inactive' = left the group
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references app_user(id) on delete set null,
    updated_by       uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    unique (ensemble_id, user_id),              -- one membership per user per ensemble
    check (vocal_range_low is null or vocal_range_high is null
        or vocal_range_low <= vocal_range_high)
);

-- The ensemble's section vocabulary: S1, A2, Bass, VP, ... Tenant-defined.
create table voice_part (
    id           uuid primary key default gen_random_uuid(),
    ensemble_id  uuid not null references ensemble(id),
    label        text not null,                  -- 'S2', 'Tenor 1', 'VP'
    sort_order   smallint not null default 0,
    is_pitched   boolean not null default true,  -- false for VP / percussion
    nominal_low  smallint,                       -- section's typical range, MIDI, advisory
    nominal_high smallint,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    created_by   uuid references app_user(id) on delete set null,
    updated_by   uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    check (nominal_low is null or nominal_high is null or nominal_low <= nominal_high)
);

-- Section labels are unique case-insensitively: the app treats 'Bass' and 'bass'
-- as the same section, so enforce that rather than a bare case-sensitive unique.
create unique index voice_part_label_ci on voice_part (ensemble_id, lower(label));

-- Which sections a member can cover, one marked home. Drives section coverage and
-- the casting screen's eligibility.
create table member_voice_part (
    ensemble_id        uuid not null references ensemble(id),
    member_id          uuid not null,
    voice_part_id      uuid not null,
    is_primary_section boolean not null default false,  -- the member's home section
    created_at         timestamptz not null default now(),
    
    primary key (member_id, voice_part_id),
    foreign key (ensemble_id, member_id)     references member(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, voice_part_id) references voice_part(ensemble_id, id) on delete cascade
);

create unique index member_one_primary_section
on member_voice_part (member_id) where (is_primary_section);


-- ----------------------------------------------------------------------------
-- Repertoire
-- ----------------------------------------------------------------------------

-- A chart. Key and tempo carry start/end values for transition and arc logic.
create table song (
    id                  uuid primary key default gen_random_uuid(),
    ensemble_id         uuid not null references ensemble(id),
    title               text not null,
    arranger            text,
    chart_ref           text,                    -- URL or location of the music
    
    start_key_fifths    smallint,                -- opening key signature, -7..+7; null = no set key
    start_key_mode      text check (start_key_mode in ('major','minor')),
    end_key_fifths      smallint,                -- closing key if it modulates; null = ends as it started
    end_key_mode        text check (end_key_mode in ('major','minor')),
    
    start_tempo_bpm     smallint,                -- opening tempo; null = free / rubato
    end_tempo_bpm       smallint,                -- closing tempo if it changes; null = constant
    
    start_pitch         text,                    -- pitch to blow before the song, a pitch class like 'C#' or 'Eb'; null = derive from the start key
    
    duration_seconds    integer,                 -- chart length; event padding applied later
    is_explicit         boolean not null default false,  -- content rating; hard-gated by event policy
    intensity           smallint,                -- director-rated felt energy, 1..5, by peak impact; null = unrated. Independent of tempo and readiness; drives the sequencer's arc and anti-flatline terms.
    
    assessed_readiness  text not null default 'learning'
    check (assessed_readiness in
    ('performance-ready','needs-polish','learning','dormant')),
    book_status         text not null default 'on-book'
    check (book_status in ('off-book','on-book')),
    last_rehearsed      date,
    last_performed      date,                     -- stamped when a setlist is marked performed
    status              text not null default 'active'
    check (status in ('active','archived')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    created_by          uuid references app_user(id) on delete set null,
    updated_by          uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    check ((start_key_fifths is null) = (start_key_mode is null)),
    check ((end_key_fifths   is null) = (end_key_mode   is null)),
    check (start_key_fifths is null or start_key_fifths between -7 and 7),
    check (end_key_fifths   is null or end_key_fifths   between -7 and 7),
    check (end_key_fifths is null or start_key_fifths is not null),
    check (start_tempo_bpm is null or start_tempo_bpm > 0),
    check (end_tempo_bpm   is null or end_tempo_bpm   > 0),
    check (end_tempo_bpm is null or start_tempo_bpm is not null),
    check (duration_seconds is null or duration_seconds > 0),
    check (intensity is null or intensity between 1 and 5),
    check (start_pitch is null or start_pitch ~ '^[A-G](#|b)?$')
);

-- One line the chart calls for. A section line names its voice part (VP included);
-- a solo names none.
create table part (
    id            uuid primary key default gen_random_uuid(),
    ensemble_id   uuid not null references ensemble(id),
    song_id       uuid not null,
    voice_part_id uuid,                           -- the section this line needs; null for a solo
    is_solo       boolean not null default false,
    label         text,                           -- display name within the song: 'Descant', 'Solo 2'
    is_required   boolean not null default true,  -- false parts degrade, they don't gate
    count_needed  smallint not null default 1,    -- minimum singers for this line to count as covered
    range_low     smallint,                       -- specific demand of this line, MIDI; mainly solos
    range_high    smallint,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    created_by    uuid references app_user(id) on delete set null,
    updated_by    uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    unique (ensemble_id, song_id, id),  -- target for performance_soloist's part-to-song bind
    foreign key (ensemble_id, song_id)
    references song(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, voice_part_id)
    references voice_part(ensemble_id, id),
    check ((is_solo and voice_part_id is null)
        or (not is_solo and voice_part_id is not null)),
    check (count_needed > 0),
    check (range_low is null or range_high is null or range_low <= range_high)
);

-- Who is assigned to a part, and how solid they feel. is_primary marks the lead on a
-- featured part; section parts leave it false.
create table casting (
    id                       uuid primary key default gen_random_uuid(),
    ensemble_id              uuid not null references ensemble(id),
    part_id                  uuid not null,
    member_id                uuid not null,
    is_primary               boolean not null default false,
    self_reported_confidence text
    check (self_reported_confidence in ('solid','shaky','learning')),
    director_assessed        text
    check (director_assessed in ('solid','shaky','learning')),  -- the director's read of this cover, distinct from the member's self-report
    learned_at               timestamptz,             -- date the cover was confirmed solid; null while not solid
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),
    created_by               uuid references app_user(id) on delete set null,
    updated_by               uuid references app_user(id) on delete set null,
    
    unique (member_id, part_id),
    foreign key (ensemble_id, part_id)
    references part(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, member_id)
    references member(ensemble_id, id) on delete cascade
);

create unique index casting_one_lead_per_part
on casting (part_id) where (is_primary);


-- ----------------------------------------------------------------------------
-- Events and their config
-- ----------------------------------------------------------------------------

-- Reusable time-overhead profile. Several event types can share one.
create table padding_profile (
    id               uuid primary key default gen_random_uuid(),
    ensemble_id      uuid not null references ensemble(id),
    name             text not null,              -- 'Concert', 'Church service', 'Competition'
    per_song_seconds integer not null default 0, -- applause, transition, brief patter, per song
    per_set_seconds  integer not null default 0, -- one-time overhead: intro, outro, MC
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    created_by       uuid references app_user(id) on delete set null,
    updated_by       uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    unique (ensemble_id, name),
    check (per_song_seconds >= 0),
    check (per_set_seconds  >= 0)
);

-- The kind of gig. Carries the type-level policy defaults. Tenant-defined.
create table event_type (
    id                      uuid primary key default gen_random_uuid(),
    ensemble_id             uuid not null references ensemble(id),
    name                    text not null,
    sort_order              smallint not null default 0,
    padding_profile_id      uuid,                -- default padding for this type
    default_allows_on_book  boolean not null default false,
    default_allows_explicit boolean not null default false,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    created_by              uuid references app_user(id) on delete set null,
    updated_by              uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    unique (ensemble_id, name),
    -- Composite FK, but SET NULL must touch ONLY padding_profile_id: a bare SET NULL on
    -- a multi-column FK also nulls ensemble_id (NOT NULL) and fails the delete. The
    -- column-list form (PostgreSQL 15+) clears just the optional reference.
    foreign key (ensemble_id, padding_profile_id)
    references padding_profile(ensemble_id, id) on delete set null (padding_profile_id)
);

-- A booking. Owns its resolved policy + padding, snapshotted from its event_type at
-- create (or "apply defaults"); editing the type afterwards does NOT change existing
-- events. event_type_id is provenance/grouping only.
create table event (
    id                      uuid primary key default gen_random_uuid(),
    ensemble_id             uuid not null references ensemble(id),
    event_type_id           uuid,                -- provenance/grouping; null = untyped
    name                    text not null,
    event_date              date,                -- null = TBD
    venue                   text,
    target_duration_seconds integer,             -- set-length goal, in seconds
    allows_on_book          boolean not null default false,
    allows_explicit         boolean not null default false,
    per_song_seconds        integer not null default 0, -- snapshotted padding: per-song overhead/gap
    per_set_seconds         integer not null default 0, -- snapshotted padding: one-time overhead
    status                  text not null default 'planned'
    check (status in ('planned','cancelled')),
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    created_by              uuid references app_user(id) on delete set null,
    updated_by              uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    -- SET NULL only event_type_id (see padding_profile note above): a bare composite
    -- SET NULL would also null ensemble_id (NOT NULL) and fail deleting an event type.
    foreign key (ensemble_id, event_type_id)
    references event_type(ensemble_id, id) on delete set null (event_type_id),
    check (target_duration_seconds is null or target_duration_seconds > 0),
    check (per_song_seconds >= 0),
    check (per_set_seconds  >= 0)
);


-- ----------------------------------------------------------------------------
-- Tags and appropriateness
-- ----------------------------------------------------------------------------

-- Open style/genre/mood/occasion vocabulary. Tenant-defined.
create table tag (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    name        text not null,                   -- 'gospel', 'holiday', 'ballad', 'uptempo'
    category    text                             -- what the tag is, so the sequencer knows what to do with it:
    -- mood/groove/genre diversify adjacency, content gates, occasion is ignored
    check (category is null or category in ('mood','groove','genre','occasion','content')),
    sort_order  smallint not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id)
);

-- Tag names are unique case-insensitively: the app treats 'Gospel' and 'gospel'
-- as the same tag, matching the editor's duplicate guard.
create unique index tag_name_ci on tag (ensemble_id, lower(name));

-- A song's tags.
create table song_tag (
    ensemble_id uuid not null references ensemble(id),
    song_id     uuid not null,
    tag_id      uuid not null,
    created_at  timestamptz not null default now(),
    
    primary key (song_id, tag_id),
    foreign key (ensemble_id, song_id) references song(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, tag_id)  references tag(ensemble_id, id)  on delete cascade
);

-- Per-event style steering: prefer toward, or exclude.
create table event_tag (
    ensemble_id uuid not null references ensemble(id),
    event_id    uuid not null,
    tag_id      uuid not null,
    effect      text not null default 'prefer'
    check (effect in ('prefer','exclude')),
    created_at  timestamptz not null default now(),
    
    primary key (event_id, tag_id),
    foreign key (ensemble_id, event_id) references event(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, tag_id)   references tag(ensemble_id, id)   on delete cascade
);

-- Standing per-type rules, mainly exclusions a type should always enforce.
create table event_type_tag (
    ensemble_id   uuid not null references ensemble(id),
    event_type_id uuid not null,
    tag_id        uuid not null,
    effect        text not null default 'prefer'
    check (effect in ('prefer','exclude')),
    created_at    timestamptz not null default now(),
    
    primary key (event_type_id, tag_id),
    foreign key (ensemble_id, event_type_id) references event_type(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, tag_id)        references tag(ensemble_id, id)        on delete cascade
);


-- ----------------------------------------------------------------------------
-- Availability and sets
-- ----------------------------------------------------------------------------

-- Self-reported attendance. A missing row means no response, distinct from 'out'.
create table availability (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    member_id   uuid not null,
    event_id    uuid not null,
    status      text not null check (status in ('in','out','tentative')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (member_id, event_id),
    foreign key (ensemble_id, member_id) references member(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, event_id)  references event(ensemble_id, id)  on delete cascade
);

-- A reusable, hand-built program, not tied to an event. The director arranges it
-- with the sequencer and seam logic alone (no availability, no feasibility), then
-- instantiates it into event setlists. Reached from its own menu. Deletable only
-- while no setlist references it (see setlist.program_id).
create table program (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    name        text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id)
);

-- A song's place in a program: ordered, with an optional opener/closer anchor.
-- Leaner than setlist_item: a program holds only chosen songs (no exclude) and
-- only the two end anchors (keep is a draft-fill concept, not an arrangement one).
create table program_item (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    program_id  uuid not null,
    song_id     uuid not null,
    position    smallint not null,               -- order in the program
    pin         text check (pin in ('open','close')),  -- end anchor; null = interior
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (program_id, song_id),
    foreign key (ensemble_id, program_id) references program(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, song_id)    references song(ensemble_id, id)    on delete cascade
);

-- At most one opener and one closer per program. The app treats these as
-- singletons; this makes the contract match (same shape as casting_one_lead_per_part).
create unique index program_one_open
on program_item (program_id) where (pin = 'open');
create unique index program_one_close
on program_item (program_id) where (pin = 'close');


-- A draft or performed set for an event. Multiple per event are allowed. A set may
-- record the program it was instantiated from (program_id), which also pins that
-- program against deletion while the set lives.
create table setlist (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    event_id    uuid not null,
    program_id  uuid,                            -- the program this set came from, if any
    name        text,                            -- 'Set 1', 'Draft B'; optional
    status      text not null default 'draft'
    check (status in ('draft','final','performed')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (ensemble_id, id),
    foreign key (ensemble_id, event_id)   references event(ensemble_id, id)   on delete cascade,
    foreign key (ensemble_id, program_id) references program(ensemble_id, id) on delete restrict
);

-- A song's relationship to a set: placed, locked, or barred. One table, three states.
create table setlist_item (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    setlist_id  uuid not null,
    song_id     uuid not null,
    position    smallint,                        -- order in the set; null when barred
    pin         text check (pin in ('keep','open','close')),  -- lock; null = drafter may move or drop
    is_excluded boolean not null default false,  -- barred from this set; drafter fills around it
    note        text,                            -- director's transition / staging annotation for this item
    transition_seconds smallint                  -- segue: the gap LEAVING this item; null = event per-song default, 0 = attacca
    check (transition_seconds is null or transition_seconds >= 0),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  uuid references app_user(id) on delete set null,
    updated_by  uuid references app_user(id) on delete set null,
    
    unique (setlist_id, song_id),
    foreign key (ensemble_id, setlist_id) references setlist(ensemble_id, id) on delete cascade,
    foreign key (ensemble_id, song_id)    references song(ensemble_id, id)    on delete cascade,
    check ( (is_excluded and position is null and pin is null)
        or (not is_excluded and position is not null) )
);

-- A break in a setlist's running order: an intermission or extended patter spot. It
-- holds clock time but takes no stage slot, and it is ORDINAL — it sits after the
-- k-th song (after_position), splitting the set into segments the drafter sequences
-- independently (a hard flow-reset). At most one break per ordinal slot.
create table setlist_break (
    id             uuid primary key default gen_random_uuid(),
    ensemble_id    uuid not null references ensemble(id),
    setlist_id     uuid not null,
    label          text not null,
    duration_seconds integer  not null check (duration_seconds >= 0),
    after_position smallint not null check (after_position >= 1),  -- after the k-th song
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    created_by     uuid references app_user(id) on delete set null,
    updated_by     uuid references app_user(id) on delete set null,
    
    unique (setlist_id, after_position),  -- one break per ordinal slot
    foreign key (ensemble_id, setlist_id) references setlist(ensemble_id, id) on delete cascade
);

-- Who actually soloed at a performance, snapshotted when a set is marked performed,
-- so the record stays true even if the casting changes later. Feeds soloist equity
-- over time. One soloist per part per performance.
create table performance_soloist (
    id          uuid primary key default gen_random_uuid(),
    ensemble_id uuid not null references ensemble(id),
    setlist_id  uuid not null,
    song_id     uuid not null,
    part_id     uuid not null,
    member_id   uuid not null,
    created_at  timestamptz not null default now(),
    
    unique (setlist_id, part_id),
    foreign key (ensemble_id, setlist_id) references setlist(ensemble_id, id) on delete cascade,
    -- One composite FK binds part to its song: the row's part must belong to its song,
    -- so a soloist can't be recorded against a part from a different song. This also
    -- covers part (and transitively song) existence, so no separate part/song FK is needed.
    foreign key (ensemble_id, song_id, part_id)
    references part(ensemble_id, song_id, id) on delete cascade,
    foreign key (ensemble_id, member_id)  references member(ensemble_id, id)  on delete cascade
);


-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------

create extension if not exists moddatetime;

do $$
declare
t text;
begin
foreach t in array array[
'app_user','ensemble','member','voice_part','song','part','casting',
'event','event_type','padding_profile','tag','availability',
'program','program_item','setlist','setlist_item','setlist_break'
]
loop
execute format(
    'create trigger %I_set_updated_at before update on %I '
    'for each row execute function moddatetime(updated_at)', t, t);
end loop;
end $$;


-- ----------------------------------------------------------------------------
-- Starter indexes (foreign-key columns and the tenant key on link tables).
-- A starting set tied to expected query paths, not a final strategy.
-- ----------------------------------------------------------------------------

create index idx_member_user                  on member (user_id);

create index idx_mvp_voice_part               on member_voice_part (voice_part_id);
create index idx_mvp_ensemble                 on member_voice_part (ensemble_id);

create index idx_part_song                    on part (song_id);
create index idx_part_voice_part              on part (voice_part_id);

create index idx_casting_part                 on casting (part_id);
create index idx_casting_ensemble             on casting (ensemble_id);

create index idx_event_type                   on event (event_type_id);

create index idx_song_tag_tag                 on song_tag (tag_id);
create index idx_song_tag_ensemble            on song_tag (ensemble_id);

create index idx_event_tag_tag                on event_tag (tag_id);
create index idx_event_tag_ensemble           on event_tag (ensemble_id);

create index idx_event_type_tag_tag           on event_type_tag (tag_id);
create index idx_event_type_tag_ensemble      on event_type_tag (ensemble_id);

create index idx_availability_event           on availability (event_id);
create index idx_availability_ensemble        on availability (ensemble_id);

create index idx_program_item_song            on program_item (song_id);
create index idx_program_item_ensemble        on program_item (ensemble_id);

create index idx_setlist_event                on setlist (event_id);
create index idx_setlist_program              on setlist (program_id);

create index idx_setlist_item_song            on setlist_item (song_id);
create index idx_setlist_item_ensemble        on setlist_item (ensemble_id);

create index idx_setlist_break_setlist        on setlist_break (setlist_id);
create index idx_setlist_break_ensemble       on setlist_break (ensemble_id);

create index idx_perf_soloist_song            on performance_soloist (song_id);
create index idx_perf_soloist_part            on performance_soloist (part_id);
create index idx_perf_soloist_member          on performance_soloist (member_id);
create index idx_perf_soloist_ensemble        on performance_soloist (ensemble_id);


-- ----------------------------------------------------------------------------
-- NEXT PASS: row-level security.
-- Enable RLS on every tenant-scoped table and add policies keyed on ensemble_id,
-- with member-self-write on availability and member, director-write elsewhere.
-- Not enabled here: enabling without policies denies all access.
-- ----------------------------------------------------------------------------
