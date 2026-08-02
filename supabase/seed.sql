-- ============================================================================
-- Local development seed. Loaded by `supabase db reset` after every migration is
-- applied. Runs as the postgres superuser, so it bypasses RLS and writes the
-- first member rows directly (create_ensemble_seeded, the founder path, needs auth.uid(),
-- which a seed run does not have).
--
-- Three ensembles, so the live data exercises what the mock cannot: RLS tenant
-- isolation, role-gated writes, confidence privacy through casting_visible, and
-- every RPC. The repertoire mirrors apps/web/lib/db.ts closely enough that the
-- Supabase adapter can be checked against the in-memory mock.
--
-- Accounts (all share the password `password123`):
--   ana@example.com — director of "Harmony Collective" (Ensemble A)
--   ben@example.com — member of Ensemble A; the non-director, non-self viewer for
--                     the confidence-privacy check (A is 'private')
--   rae@example.com — director of "Riverside Singers" (Ensemble B); isolation peer
--
-- Fixed UUIDs for the five auth accounts so tests can reference them; everything
-- else is gen_random_uuid() inside the DO block, wired by composite FK.
-- ============================================================================

-- Local-only guard (B2). This seed creates well-known accounts with a published password,
-- so it must never touch a network-reachable database. The Supabase local stack ships a
-- well-known PUBLIC demo JWT secret (the same one in every local install — not a credential);
-- a hosted project sets its own. Refuse to run unless that demo secret is in effect, so a
-- stray `supabase db reset --linked` cannot backdoor a real instance. The migration path to a
-- remote is `supabase db push`, which never runs seeds — this is defense in depth on top of that.
do $$
begin
if current_setting('app.settings.jwt_secret', true)
is distinct from 'super-secret-jwt-token-with-at-least-32-characters-long' then
raise exception 'seed.sql refuses to run outside the local development stack'
using
detail = 'app.settings.jwt_secret is not the public local-stack default, so this is not the local database.',
hint = 'Seeds run only via `supabase db reset` on the local stack. Reach a remote with `supabase db push` (which does not seed); never `supabase db reset --linked`.';
end if;
end $$;

-- The auth users. The on_auth_user_created trigger mirrors each into app_user.
insert into auth.users
(instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000a1',
    'authenticated', 'authenticated', 'ana@example.com', crypt('password123', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ana"}'),
('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b2',
    'authenticated', 'authenticated', 'ben@example.com', crypt('password123', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Ben"}'),
('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000c3',
    'authenticated', 'authenticated', 'rae@example.com', crypt('password123', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Rae"}'),
-- Mia directs an ARCHIVED ensemble only — the R-status fixture (her tier must resolve to null).
('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000d4',
    'authenticated', 'authenticated', 'mia@example.com', crypt('password123', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Mia"}'),
-- Sam is the platform-admin fixture: an operator who belongs to no ensemble, flagged is_platform_admin
-- below. Proves the admin perimeter gate lets an admin through (the non-admin fixtures prove the deny
-- path). Kept out of every ensemble so it never shifts a tenant-scoped test's active ensemble.
('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000e5',
    'authenticated', 'authenticated', 'sam@example.com', crypt('password123', gen_salt('bf')),
    now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Sam"}');

-- GoTrue scans these token columns as non-null Go strings; a NULL trips a 500
-- "Database error querying schema" on login. The migrations never touch auth.users,
-- so default them to '' here for the seeded accounts to be loginable.
update auth.users
set confirmation_token = '', recovery_token = '', email_change_token_new = '',
email_change = '', email_change_token_current = '', phone_change = '',
phone_change_token = '', reauthentication_token = ''
where email in ('ana@example.com', 'ben@example.com', 'rae@example.com', 'mia@example.com', 'sam@example.com');

-- Migration 057 gates create_ensemble_seeded on a founding credit (admin-authorized creation). Mia is
-- the onboarding fixture: she founds her first ensemble through the real create flow (the onboarding
-- e2e), so grant her the credit an admin invite would. The generous balance keeps the 20-owned founding
-- quota the binding limit on repeated local runs, so e2e ergonomics match the pre-057 behavior; a single
-- CI run needs just one.
update app_user set founding_credits = 25 where id = '00000000-0000-0000-0000-0000000000d4';

-- Sam is the platform-admin fixture (see the auth.users insert above). Set the flag here the way the
-- real cutover would (a superuser statement), not through any app route; auth_is_platform_admin() reads it.
update app_user set is_platform_admin = true where id = '00000000-0000-0000-0000-0000000000e5';

do $$
declare
u_ana  uuid := '00000000-0000-0000-0000-0000000000a1';
u_ben  uuid := '00000000-0000-0000-0000-0000000000b2';
u_rae  uuid := '00000000-0000-0000-0000-0000000000c3';
u_mia  uuid := '00000000-0000-0000-0000-0000000000d4';

-- Ensemble C — archived; the R-status fixture (its members get no tier).
ens_c  uuid := gen_random_uuid();
m_mia  uuid := gen_random_uuid();
s_c1   uuid := gen_random_uuid();

ens_a uuid := gen_random_uuid();
ens_b uuid := gen_random_uuid();

-- Ensemble A members
m_ana  uuid := gen_random_uuid();
m_ben  uuid := gen_random_uuid();
m_cleo uuid := gen_random_uuid();
m_dane uuid := gen_random_uuid();
m_rae  uuid := gen_random_uuid();  -- Ensemble B director

-- Ensemble A voice parts
vp_sop uuid := gen_random_uuid();
vp_alt uuid := gen_random_uuid();
vp_ten uuid := gen_random_uuid();
vp_bas uuid := gen_random_uuid();
vp_vp  uuid := gen_random_uuid();
vp_b   uuid := gen_random_uuid();  -- Ensemble B

-- Ensemble A tags (only the ones the seeded songs use)
t_gospel    uuid := gen_random_uuid();
t_soul      uuid := gen_random_uuid();
t_uptempo   uuid := gen_random_uuid();
t_ballad    uuid := gen_random_uuid();
t_spiritual uuid := gen_random_uuid();
t_b         uuid := gen_random_uuid();  -- Ensemble B

-- Ensemble A songs
s_wade   uuid := gen_random_uuid();
s_lean   uuid := gen_random_uuid();
s_stand  uuid := gen_random_uuid();
s_bridge uuid := gen_random_uuid();
s_grave  uuid := gen_random_uuid();
s_b1     uuid := gen_random_uuid();  -- Ensemble B
s_b2     uuid := gen_random_uuid();

-- Ensemble A parts (Lead = solo, Bass = section line)
p_wade_l   uuid := gen_random_uuid();
p_wade_b   uuid := gen_random_uuid();
p_lean_l   uuid := gen_random_uuid();
p_lean_b   uuid := gen_random_uuid();
p_stand_l  uuid := gen_random_uuid();
p_stand_b  uuid := gen_random_uuid();
p_bridge_l uuid := gen_random_uuid();
p_bridge_b uuid := gen_random_uuid();
p_grave_l  uuid := gen_random_uuid();
p_grave_b  uuid := gen_random_uuid();
p_b1       uuid := gen_random_uuid();  -- Ensemble B
p_b2       uuid := gen_random_uuid();

-- Templating presets + events + setlists (Ensemble A)
pp_concert uuid := gen_random_uuid();
pp_service uuid := gen_random_uuid();
et_concert uuid := gen_random_uuid();
et_service uuid := gen_random_uuid();
ev_concert uuid := gen_random_uuid();
ev_winter  uuid := gen_random_uuid();
ev_b       uuid := gen_random_uuid();  -- Ensemble B
sl_concert uuid := gen_random_uuid();
sl_winter  uuid := gen_random_uuid();
pg_spring  uuid := gen_random_uuid();
begin
-- ----------------------------------------------------------------------------
-- Ensemble A — "Harmony Collective" (confidence private)
-- ----------------------------------------------------------------------------
insert into ensemble (id, name, slug, confidence_visibility)
values (ens_a, 'Harmony Collective', 'harmony', 'private');

-- Cleo + Dane are PENDING invites (user_id null, invite recorded in the member_invite side
-- table) — the claim-flow fixtures. Cleo is invited under rae's address: rae (director of
-- Ensemble B, not yet in A) claims that seat. Dane is invited under ana's address: ana already
-- holds a seat in A, so her claim must SKIP Dane's seat (the unique (ensemble_id,user_id) guard).
insert into member (id, ensemble_id, user_id, display_name, permission_tier, status) values
(m_ana,  ens_a, u_ana,  'Ana',  'director', 'active'),
(m_ben,  ens_a, u_ben,  'Ben',  'member',   'active'),
(m_cleo, ens_a, null,   'Cleo', 'member',   'active'),
(m_dane, ens_a, null,   'Dane', 'member',   'active');

-- Pending-invite state lives in the director-only side table now (bug #1 / sec #2).
insert into member_invite (ensemble_id, member_id, invite_email, invited_at, invite_token_hash) values
(ens_a, m_cleo, 'rae@example.com', now(), encode(extensions.digest('cleo-invite-token', 'sha256'), 'hex')),
(ens_a, m_dane, 'ana@example.com', now(), encode(extensions.digest('dane-invite-token', 'sha256'), 'hex'));

insert into voice_part (id, ensemble_id, label, sort_order, is_pitched, nominal_low, nominal_high) values
(vp_sop, ens_a, 'Soprano',          0, true,  60, 81),
(vp_alt, ens_a, 'Alto',             1, true,  55, 74),
(vp_ten, ens_a, 'Tenor',            2, true,  48, 69),
(vp_bas, ens_a, 'Bass',             3, true,  40, 60),
(vp_vp,  ens_a, 'Vocal Percussion', 4, false, null, null);

insert into member_voice_part (ensemble_id, member_id, voice_part_id, is_primary_section) values
(ens_a, m_ana,  vp_sop, true),
(ens_a, m_ben,  vp_ten, true),
(ens_a, m_cleo, vp_alt, true),
(ens_a, m_cleo, vp_sop, false),
(ens_a, m_dane, vp_bas, true);

insert into tag (id, ensemble_id, name, category, sort_order) values
(t_gospel,    ens_a, 'gospel',    'genre',    0),
(t_soul,      ens_a, 'soul',      'genre',    1),
(t_uptempo,   ens_a, 'uptempo',   'groove',   2),
(t_ballad,    ens_a, 'ballad',    'mood',     3),
(t_spiritual, ens_a, 'spiritual', 'occasion', 4);

-- Songs. last_performed on the four that ran at the winter set, so the recency
-- penalty has signal; grave is unperformed.
insert into song (id, ensemble_id, title, start_key_fifths, start_key_mode,
    end_tempo_bpm, start_tempo_bpm, duration_seconds, intensity,
    assessed_readiness, book_status, status, last_performed) values
(s_wade,   ens_a, 'Wade in the Water',           0, 'major', null, 96, 240, 3, 'performance-ready', 'off-book', 'active', date '2026-02-14'),
(s_lean,   ens_a, 'Lean on Me',                 -1, 'major', null, 88, 235, 3, 'performance-ready', 'off-book', 'active', date '2026-02-14'),
(s_stand,  ens_a, 'Stand By Me',                 0, 'major', null, 100, 240, 3, 'performance-ready', 'off-book', 'active', date '2026-02-14'),
(s_bridge, ens_a, 'Bridge Over Troubled Water',  0, 'minor', null, 68, 255, 2, 'learning',          'on-book',  'active', date '2026-02-14'),
(s_grave,  ens_a, 'Ain''t No Grave',             2, 'major', 144, 132, 230, 5, 'learning',          'off-book', 'active', null);

insert into song_tag (ensemble_id, song_id, tag_id) values
(ens_a, s_wade,   t_gospel),
(ens_a, s_wade,   t_spiritual),
(ens_a, s_lean,   t_soul),
(ens_a, s_stand,  t_soul),
(ens_a, s_bridge, t_ballad),
(ens_a, s_grave,  t_gospel),
(ens_a, s_grave,  t_uptempo);

-- Parts: each song a featured Lead (solo) + a Bass section line.
insert into part (id, ensemble_id, song_id, voice_part_id, is_solo, label, is_required, count_needed) values
(p_wade_l,   ens_a, s_wade,   null,   true,  'Lead', true, 1),
(p_wade_b,   ens_a, s_wade,   vp_bas, false, 'Bass', true, 1),
(p_lean_l,   ens_a, s_lean,   null,   true,  'Lead', true, 1),
(p_lean_b,   ens_a, s_lean,   vp_bas, false, 'Bass', true, 1),
(p_stand_l,  ens_a, s_stand,  null,   true,  'Lead', true, 1),
(p_stand_b,  ens_a, s_stand,  vp_bas, false, 'Bass', true, 1),
(p_bridge_l, ens_a, s_bridge, null,   true,  'Lead', true, 1),
(p_bridge_b, ens_a, s_bridge, vp_bas, false, 'Bass', true, 1),
(p_grave_l,  ens_a, s_grave,  null,   true,  'Lead', true, 1),
(p_grave_b,  ens_a, s_grave,  vp_bas, false, 'Bass', true, 1);

-- Castings. The Lead casting is the featured lead (is_primary). Confidence and the
-- director's read mirror the mock: grave's lead (Cleo) is shaky / still learning,
-- Ana's grave bass is solid (confirmed), Dane's bridge lead is shaky.
insert into casting (ensemble_id, part_id, member_id, is_primary, self_reported_confidence, director_assessed, learned_at) values
(ens_a, p_wade_l,   m_ana,  true,  'solid',    null,       null),
(ens_a, p_wade_b,   m_cleo, false, 'solid',    null,       null),
(ens_a, p_lean_l,   m_ana,  true,  'solid',    null,       null),
(ens_a, p_lean_b,   m_ben,  false, 'solid',    null,       null),
(ens_a, p_stand_l,  m_ana,  true,  'solid',    null,       null),
(ens_a, p_stand_b,  m_ben,  false, 'solid',    null,       null),
(ens_a, p_bridge_l, m_dane, true,  'solid',    'shaky',    null),
(ens_a, p_bridge_b, m_ben,  false, 'solid',    null,       null),
(ens_a, p_grave_l,  m_cleo, true,  'shaky',    'learning', null),
(ens_a, p_grave_b,  m_ana,  false, 'solid',    'solid',    timestamptz '2026-05-01');

-- Templating presets + the events snapshotted from them.
insert into padding_profile (id, ensemble_id, name, per_song_seconds, per_set_seconds) values
(pp_concert, ens_a, 'Concert',        30, 90),
(pp_service, ens_a, 'Church service', 20, 180);

insert into event_type (id, ensemble_id, name, sort_order, padding_profile_id, default_allows_on_book, default_allows_explicit) values
(et_concert, ens_a, 'Concert',        0, pp_concert, true, false),
(et_service, ens_a, 'Church service', 1, pp_service, true, false);

insert into event (id, ensemble_id, event_type_id, name, event_date, venue,
    target_duration_seconds, allows_on_book, allows_explicit,
    per_song_seconds, per_set_seconds, status) values
(ev_concert, ens_a, et_concert, 'Summer concert',  date '2026-06-28', 'Memorial Hall', 1140, true, false, 30, 90, 'planned'),
(ev_winter,  ens_a, null,       'Winter showcase', date '2026-02-14', 'Old Chapel',    1080, true, false, 30, 60, 'planned');

-- Concert: everyone in, so the draft can fill freely.
insert into availability (ensemble_id, member_id, event_id, status) values
(ens_a, m_ana,  ev_concert, 'in'),
(ens_a, m_ben,  ev_concert, 'in'),
(ens_a, m_cleo, ev_concert, 'in'),
(ens_a, m_dane, ev_concert, 'in');

-- Two setlists: a clean draft (no items — the order is computed), and a past
-- performed set with a frozen order, a segue, a note, an intermission, and the
-- soloists snapshotted at perform time. The winter set is seeded as a draft, its frozen
-- children inserted, then performed at the end — mirroring the real lifecycle and keeping it
-- compatible with the performed-children INSERT guard (migration 18, which forbids inserting
-- a child into an already-performed setlist).
insert into setlist (id, ensemble_id, event_id, name, status, performed_date) values
(sl_concert, ens_a, ev_concert, 'Main set',   'draft', null),
(sl_winter,  ens_a, ev_winter,  'Winter set', 'draft', null);

insert into setlist_item (ensemble_id, setlist_id, song_id, position, pin, is_excluded, note, transition_seconds) values
(ens_a, sl_winter, s_lean,   1, null, false, null,                            null),
(ens_a, sl_winter, s_stand,  2, null, false, null,                            0),
(ens_a, sl_winter, s_bridge, 3, null, false, 'Soft open, let the room settle', null),
(ens_a, sl_winter, s_wade,   4, null, false, null,                            null);

insert into setlist_break (ensemble_id, setlist_id, label, duration_seconds, after_position) values
(ens_a, sl_winter, 'Intermission', 600, 2);

-- Denormalized display fields (song_title/part_label/member_display_name) are frozen at
-- perform time, derived here by join so they match the seeded rows. They keep the soloist
-- record true even after the part/song/member is later deleted (schema: migration 14).
insert into performance_soloist
(ensemble_id, setlist_id, song_id, part_id, member_id, song_title, part_label, member_display_name)
select ens_a, sl_winter, v.song_id, v.part_id, v.member_id, sg.title, coalesce(pt.label, 'Solo'), m.display_name
from (values
    (s_lean,   p_lean_l,   m_ana),
    (s_stand,  p_stand_l,  m_ana),
    (s_bridge, p_bridge_l, m_dane),
    (s_wade,   p_wade_l,   m_ana)
) as v(song_id, part_id, member_id)
join song   sg on sg.id = v.song_id
join part   pt on pt.id = v.part_id
join member m  on m.id  = v.member_id;

-- Now freeze the winter set (its children are all in place). The draft -> performed flip is
-- normally allowed only inside perform_setlist (migration 21); the seed can't call that RPC
-- (no director JWT), so it vouches for this one legitimate flip with the same txn-local flag.
perform set_config('app.perform_writer', 'rpc', true);
update setlist set status = 'performed', performed_date = date '2026-02-14' where id = sl_winter;

-- A saved, staffing-independent playground program (schema: program + program_item):
-- an ordered arrangement with opener/closer anchors, instantiable into an event later.
insert into program (id, ensemble_id, name) values (pg_spring, ens_a, 'Spring concert');
insert into program_item (ensemble_id, program_id, song_id, position, pin) values
(ens_a, pg_spring, s_stand, 0, 'open'),
(ens_a, pg_spring, s_lean,  1, null),
(ens_a, pg_spring, s_wade,  2, 'close');

-- ----------------------------------------------------------------------------
-- Ensemble B — "Riverside Singers". Minimal, only to prove tenant isolation:
-- Ana (A) must never see any of these rows.
-- ----------------------------------------------------------------------------
insert into ensemble (id, name, slug) values (ens_b, 'Riverside Singers', 'riverside');

insert into member (id, ensemble_id, user_id, display_name, permission_tier, status) values
(m_rae, ens_b, u_rae, 'Rae', 'director', 'active');

insert into voice_part (id, ensemble_id, label, sort_order) values (vp_b, ens_b, 'Soprano', 0);
insert into tag (id, ensemble_id, name, category) values (t_b, ens_b, 'folk', 'genre');

insert into song (id, ensemble_id, title, start_key_fifths, start_key_mode, start_tempo_bpm, duration_seconds, intensity, assessed_readiness, status) values
(s_b1, ens_b, 'Shenandoah',       1, 'major', 72, 200, 2, 'performance-ready', 'active'),
(s_b2, ens_b, 'The Water Is Wide', -1, 'major', 66, 210, 2, 'performance-ready', 'active');

insert into song_tag (ensemble_id, song_id, tag_id) values
(ens_b, s_b1, t_b),
(ens_b, s_b2, t_b);

insert into part (id, ensemble_id, song_id, voice_part_id, is_solo, label) values
(p_b1, ens_b, s_b1, null, true, 'Lead'),
(p_b2, ens_b, s_b2, null, true, 'Lead');

insert into casting (ensemble_id, part_id, member_id, is_primary, self_reported_confidence) values
(ens_b, p_b1, m_rae, true, 'solid'),
(ens_b, p_b2, m_rae, true, 'solid');

insert into event (id, ensemble_id, name, event_date, target_duration_seconds, per_song_seconds, per_set_seconds, status) values
(ev_b, ens_b, 'Riverside spring sing', date '2026-04-12', 900, 30, 60, 'planned');

insert into availability (ensemble_id, member_id, event_id, status) values
(ens_b, m_rae, ev_b, 'in');

-- ----------------------------------------------------------------------------
-- Ensemble C — "Retired Choir", ARCHIVED. The R-status fixture: Mia is its active
-- director, but because the ensemble is archived her auth_member_tier resolves to
-- null, so she can read none of its content (her own member row stays self-readable).
-- ----------------------------------------------------------------------------
insert into ensemble (id, name, slug, status) values (ens_c, 'Retired Choir', 'retired', 'archived');
insert into member (id, ensemble_id, user_id, display_name, permission_tier, status) values
(m_mia, ens_c, u_mia, 'Mia', 'director', 'active');
insert into song (id, ensemble_id, title, start_key_fifths, start_key_mode, start_tempo_bpm, duration_seconds, intensity, assessed_readiness, status) values
(s_c1, ens_c, 'Auld Lang Syne', 0, 'major', 60, 180, 2, 'performance-ready', 'active');
end $$;
