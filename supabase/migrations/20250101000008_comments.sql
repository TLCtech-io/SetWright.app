-- Catalog comments, and nothing else. Every statement is a comment on an object created in
-- 001 through 007, so this file applies last and depends on all of them. Nothing here depends
-- on anything else here, so the order below is for readers only: schema, then tables and
-- columns, then the view, then policies, then functions.
--
-- What earns a comment: something a reader looking at the object in psql or in the dashboard
-- cannot see, where being wrong about it fails silently. Ordinary behaviour belongs in the file
-- that creates the object. Three of these confirm a design rather than warn about one: peer
-- visibility of RSVPs, of attendance, and of who covers which part. All three are intended and
-- shipped, and a review read the first as a leak because nothing at the object said so.
--
-- One constraint on the text itself. scripts/check-search-path-pins.mjs regexes the raw file to
-- build its model of which functions are live and which are pinned, so a comment string that
-- spelled out a function declaration, a drop, or a pin statement would enter that model and
-- either fail CI or quietly corrupt it. Functions are named bare throughout.


-- ----------------------------------------------------------------------------
-- Schema
-- ----------------------------------------------------------------------------

comment on schema public is 'standard public schema';


-- ----------------------------------------------------------------------------
-- app_user
-- ----------------------------------------------------------------------------

comment on column app_user.is_platform_admin is
'Authorizes the /admin surface and the admin-invite path only. It confers no cross-tenant data '
'access: no policy references it. Writable by service_role and direct SQL alone. authenticated '
'holds update on email and display_name only, and that column grant, not any policy, is what '
'stops a user PATCHing this flag onto their own row; founding_credits inherits the same '
'protection. A permission-denied error on a new self-editable column is fixed by adding that one '
'column to the grant, never by restoring a table-level update grant.';

comment on column app_user.founding_credits is
'Credits to found an ensemble. A platform admin grants one; create_ensemble_seeded consumes one '
'atomically. A user with zero credits is refused, which is the gate on the whole director '
'on-ramp. Not writable by authenticated, for the reason on is_platform_admin.';


-- ----------------------------------------------------------------------------
-- event_type_tag
-- ----------------------------------------------------------------------------

comment on table event_type_tag is
'Standing per-type tag rules, mainly exclusions. Nothing server-side applies them to an event. '
'save_event resolves event_tag from its own arguments and never reads this table. The copy '
'happens in the new-event form, and only while the form is untouched, so changing an existing '
'event type, an import, a seed, or any other non-form caller gets none of it. Treat that as a '
'known gap rather than a contract: a rule set here can be silently absent from an event.';


-- ----------------------------------------------------------------------------
-- member
-- ----------------------------------------------------------------------------

comment on column member.is_singing is
'False means an active member with platform access who is not pulled into the singing pool, a '
'conductor or a manager. Clearing it is destructive. The app follows with prune_member_coverage, '
'which deletes every casting and every availability row for this member with no event or date '
'predicate, past and performed events included, then promotes a new primary on any solo part they '
'led. There is no undo. Go through save_member with p_prune so the prune runs; a direct write '
'skips it and leaves a non-singing member still counted by the coverage gate.';

comment on column member.status is
'inactive means left the group. set_member_status runs prune_member_coverage on the way, which '
'deletes every casting and every availability row for this member, past and performed events '
'included, and promotes a new primary on any solo part they led, then revokes any pending invite '
'for the seat. There is no undo, and reactivating the row does not bring the coverage back. A '
'direct update to inactive skips all of it and leaves a member the coverage gate still counts.';


-- ----------------------------------------------------------------------------
-- member_invite
-- ----------------------------------------------------------------------------

comment on column member_invite.first_invited_at is
'When this invitation was first recorded. Never updated; refresh_pending_invite caps self-serve '
'renewal against it.';

comment on column member_invite.declined_at is
'Set when the invitee refuses. The row stays so the roster can show the director it was declined, '
'and nothing re-offers it.';


-- ----------------------------------------------------------------------------
-- setlist
--
-- Four jsonb columns on one table with four different freshness contracts. The comments say
-- which is frozen and which is kept current, because the failure mode of guessing wrong is a
-- stale running order at a real gig with no error anywhere.
-- ----------------------------------------------------------------------------

comment on column setlist.published_order is
'The order members read for a published set. Shape: { songIds, transitions, breaks }. Not frozen '
'at publish, despite the name: the app rewrites it, and draft_order with it, on every '
'order-changing edit until the set is performed. Any new order-changing path has to resync both '
'or members read a stale running order. Paired with published_at by constraint, both null or '
'both set.';

comment on column setlist.draft_order is
'The order members read for a shared draft, same shape as published_order, kept current as the '
'director edits. A shared draft is served from this column on the parent row alone, which is why '
'members read no setlist_item or setlist_break rows for one.';

comment on column setlist.arranged_order is
'The running order the director arranged by hand, as a jsonb array of song ids. Advisory and '
'order-only: the drafter still decides which songs are in the set, and loadSetlist reconciles a '
'stale or partial list against it. A redraft clears it back to null and the canonical order takes '
'over; a drag or auto-arrange sets it.';

comment on column setlist.performed_snapshot is
'Frozen song metadata + event name/padding for a performed set, captured at perform time. Null '
'for sets performed before this column (they fall back to live reads). Shape: { songs: '
'SongRow[], eventName: text, padding: { perSongSeconds, perSetSeconds } }.';


-- ----------------------------------------------------------------------------
-- casting_visible
-- ----------------------------------------------------------------------------

comment on view casting_visible is
'Runs with the rights of its owner on purpose, and must keep doing so. Members match no select '
'policy on the casting base table at all, so this view is their only read path: its where clause '
'is the tenant boundary and its case arms are the confidence guard. Setting security_invoker on '
'it, which the Supabase database advisor recommends for owner-rights views, returns zero rows to '
'every non-director and raises nothing; removing the where clause exposes every tenant. The '
'security_barrier property is deliberate too, and was measured against the hottest read the '
'drafter makes before it shipped. Who covers which part is peer-visible by design, and that is '
'what the member console shows. Only self-reported confidence (unless the ensemble sets '
'confidence_visibility to shared), the director assessment, and learned_at are withheld.';


-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------

comment on policy availability_read on availability is
'Tenant-wide by intent, not by oversight. Every active member sees every peer RSVP for their own '
'ensemble, which is what the shipped member copy about seeing who else is coming refers to. '
'Narrowing this to self would fail silently rather than loudly: the call sheet buckets a member '
'with no visible row as pending, so every peer would simply render as no reply.';

comment on policy attendance_read on attendance is
'Tenant-wide by intent, matching availability_read: within an ensemble, who turned up is not '
'private between members. Writes stay director-only through attendance_write, because attendance '
'is a record the director keeps rather than a self-reported one. Only the director rehearsal '
'record reads this table today, so narrowing the policy would break no screen and no test, which '
'is exactly why the intent is recorded here.';

comment on policy casting_select_director on casting is
'Load-bearing beyond making the data visible. A filtered director write (delete or update ... '
'where part_id in (...)) needs its target rows visible through a select policy or it silently '
'matches nothing. set_song_casting also depends on it: it snapshots the prior castings for the '
'song before replacing them, so self-reported confidence, the director assessment and learned_at '
'survive the replace. Remove this policy and that snapshot comes back empty, the write still '
'succeeds, and the learning history for the song is erased with no error.';

comment on policy setlist_item_read on setlist_item is
'Stops at published or performed on purpose. Do not add share_draft here to match setlist_read: a '
'shared draft is served entirely from setlist.draft_order on the parent row, so members never '
'need these rows for one. Widening it hands them the songs the director excluded, the open, close '
'and keep pins, and the per-item staging notes.';

comment on policy setlist_break_read on setlist_break is
'Stops at published or performed on purpose, for the same reason as setlist_item_read: a shared '
'draft is served from setlist.draft_order on the parent row, so adding share_draft here only '
'leaks the private drafting state of the director.';


-- ----------------------------------------------------------------------------
-- Functions
-- ----------------------------------------------------------------------------

comment on function guard_member_binding() is
'The only code that can bind member.user_id is a security definer function owned by postgres, '
'because this guard exempts any current_user outside authenticated and anon. Today that is '
'accept_invitation, whose ability to write user_id rests on that ownership and nothing else, so '
'declaring it invoker, or adding an invoker RPC that joins a seat, starts raising what looks like '
'an RLS error. The improvisation to refuse is routing the insert through the service-role client: '
'the guard passes and the invitee consent model is gone.';

comment on function hydrate_draft_input(uuid) is
'The search path pin on this function is pg_catalog, public, pg_temp, not the pg_catalog, pg_temp '
'that every other pinned function here uses, because the body names its tables unqualified. A '
'redeclaration resets the function configuration and loses the pin unless it carries the set '
'clause with this exact value. CI verifies only that a pin exists, never what it is, and npm run '
'verify never touches SQL, so the whole drafting surface fails at runtime instead: relation '
'"event" does not exist.';

comment on function hydrate_setlist_locks(uuid) is
'Same search path pin as hydrate_draft_input, pg_catalog, public, pg_temp, and for the same '
'reason: the body names its tables unqualified. A redeclaration that copies the house pattern '
'from a neighbouring function loses it, and nothing offline catches that.';

comment on function perform_setlist(uuid, uuid[], jsonb) is
'p_snapshot is written once and can never be corrected. It rides the same update that flips the '
'row to performed, which the performed-immutability trigger allows because the row is still a '
'draft at that statement. Every later update to a performed row is rejected, so a second '
'frozen-at-perform column written afterwards silently never lands: the trigger raises, the '
'readers fall back to live data, and it looks like nothing happened. That already shipped once. '
'Build p_snapshot with the same first-occurrence dedupe and 512 cap this function applies to '
'p_order, or the frozen program stops matching the frozen items. A null p_snapshot succeeds, and '
'the readers fall back to live song and event data.';

comment on function set_my_availability(uuid, text) is
'Security definer, and the internal resolution of the caller''s own active member row in an '
'active ensemble is the entire authorization. No RLS runs behind it, so those checks are the gate '
'and not belt and braces. It is definer so it can advance event.updated_at past the director-only '
'event policy, and that bump is what makes a director bulk save conflict and reload instead of '
'clobbering a member RSVP. Restoring it to invoker reintroduces the lost update silently.';
