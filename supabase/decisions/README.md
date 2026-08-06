# Why the schema is the way it is

`supabase/migrations/20250101000001..008` records **what** the schema is. This directory records
**why**. Eight files, one per baseline migration, covering the decisions, tradeoffs and traps a
reader of the object cannot reconstruct from the object.

Read a record when you are about to change something and want to know what the current shape is
protecting. Read the SQL when you want to know what the shape is. The records do not restate the
SQL.

The 64 migrations this baseline replaced are in `supabase/migrations/_archive/`. Where a record
names an archive file, that file holds the full original text: the probe that found a bug, the
plans behind a measurement, the reasoning as it was written at the time.

## What to trust when these disagree

The running code wins. Then the baseline SQL. Then these records. Then the archive, which is
history and nothing more.

That order is not a formality. Documentation maintenance lagged development on this project, and
the behaviour that shipped was the intended path, so a comment describing something the code does
not do is a stale comment rather than a defect in the code. A sweep of the baseline in August 2026
found 26 false claims in its own comments, 19 inherited verbatim from older migrations that no
later migration had contradicted. Several archive headers were already wrong before the archive
was made.

So when a record and the code disagree, correct the record. Raise a defect only when the code is
wrong on its own terms, not merely different from something written about it. A security review
that read the old prose as authoritative concluded the RLS policies were broken and proposed
narrowing them, which would have removed a feature members use.

## The eight files

| File | Covers |
| --- | --- |
| [001-schema.md](001-schema.md) | 27 tables, their columns, constraints and 49 indexes |
| [002-rls.md](002-rls.md) | The auth helpers, table grants, 54 policies, `casting_visible` |
| [003-guards.md](003-guards.md) | Trigger functions, immutability, the `moddatetime` loop, the GUC handshake |
| [004-hydration.md](004-hydration.md) | `hydrate_draft_input`, `hydrate_setlist_locks`, the search path pins |
| [005-rpc-director.md](005-rpc-director.md) | The 20 director write RPCs |
| [006-rpc-member.md](006-rpc-member.md) | The three member self-service RPCs |
| [007-rpc-platform.md](007-rpc-platform.md) | Provisioning, invites, founding credits, rate limiting, the platform admin |
| [008-comments.md](008-comments.md) | Why each catalog comment exists, and what the object comments are protecting |

## Find an object

### Tables and columns

| Object | Where the reasoning is |
| --- | --- |
| Composite tenant FKs, `unique (ensemble_id, id)` | 001, *Tenancy is enforced twice* |
| `on delete` choices, including the two column-list SET NULLs | 001, *On delete* |
| `performance_soloist` and its denormalised columns | 001, *History must not depend on the present* |
| `setlist.arranged_order`, `draft_order`, `published_order` | 001, *The three setlist order columns*; also 008 |
| `setlist.performed_snapshot`, `performed_date` | 001; the write window is in 005 and 008 |
| `updated_at` as an optimistic concurrency token | 001, *The updated_at version token*; the RPC side is in 005 |
| `attendance`, `prep_target`, `rehearsal_item` and their stale `updated_at` | 001 and 003 |
| `tag.category`, `event_type_tag`, `part.sort_order`, `event.kind` | 001, *Columns that look like signals and are not* |
| `event.max_duration_seconds`, the accompaniment flags | 001; the projection history is in 004 |
| `availability` vs `attendance` vs `prep_target` | 001 |
| `member_invite`, `invite_token_hash`, `first_invited_at`, `declined_at` | 001; the invite lifecycle is in 007 |
| `member_invite_one_per_email` and its missing predicate | 001; the consequence is in 007 |
| `app_user.is_platform_admin`, `founding_credits` | 001, 002, 007 and 008 |
| `public_id` and `gen_public_id()` | 001; the fuller note is in 007 |
| `invite_rate_event` | 001 for the table shape, 002 for deny-all, 007 for the limiter |
| Auto-generated check constraint names | 001, *Traps* |
| Why primary keys are v4 and id order is not creation order | 001, *Traps* |

### Policies, grants and the view

| Object | Where the reasoning is |
| --- | --- |
| `auth_member_tier`, `auth_is_self`, `auth_is_platform_admin` | 002 |
| The blanket grants, and what `anon` actually holds | 002, *Grants decide whether, policies decide which* |
| The `app_user` column privilege pin | 002; the failure shape is in 008 |
| `availability_read`, `attendance_read` | 002, *Peer visibility is the product*; also 008 |
| `casting_select_director` | 002; its second dependent is in 008 |
| `casting_visible`, owner rights and `security_barrier` | 002 and 008; the plan measurement is in 004 |
| `setlist_read`, `setlist_item_read`, `setlist_break_read` | 002; the deliberate gap is in 008 |
| `member_invite_read` and the four definer readers | 002 and 007 |
| `program_read`, `program_item_read` | 002, *Setlist: two member paths* |
| Permissive policy composition, and why policies are written out | 002, *Composition traps* |

### Functions and triggers

| Object | Where the reasoning is |
| --- | --- |
| `handle_new_user`, `handle_user_email_change` | 003, *The auth.users mirror* |
| `guard_casting_confidence` | 003; the member side is in 006 |
| `guard_performed_child`, `guard_performed_setlist` | 003, *Performed history took three passes* |
| `guard_last_director`, `guard_member_binding` | 003, *Member seat invariants*; the stale binder list is in 008 |
| `guard_event_kind_immutable` | 003; the write path is in 005 |
| The `moddatetime` DO loop and the three tables it misses | 003 |
| `app.casting_writer`, `app.perform_writer` | 003, *The GUC handshake*; the RPC side is in 005 |
| `hydrate_draft_input`, `hydrate_setlist_locks` | 004 |
| The search path pin values, and what a redeclaration drops | 004 and 008 |
| `save_song`, `create_song`, `set_song_casting` | 005 |
| `set_availability`, `set_breaks`, `set_pins`, `set_item_field` | 005 |
| `perform_setlist` | 005; the incident is retold at the object in 008 |
| `prune_member_coverage` | 005; its destructiveness is in 008 |
| `save_event`, `save_event_type`, `reorder_vocab` | 005 |
| `save_attendance`, `save_rehearsal_agenda`, `save_prep_targets` | 005, *The three kind guards point different ways* |
| `mark_songs_rehearsed`, `clone_setlist`, `create_setlist_from_program`, `save_member`, `save_program` | 005 |
| `set_my_availability`, `set_my_confidence`, `update_my_profile` | 006; `set_my_availability` also in 008 |
| `create_ensemble_seeded`, `ensemble_seat_for_email`, `set_member_status` | 007 |
| `accept_invitation`, `decline_invitation`, `list_pending_invitations`, `refresh_pending_invite` | 007, *Invitation consent* |
| `grant_founding_credit`, `grant_founding_credit_by_email`, `consume_founding_credit` | 007, *Founding credits* |
| `consume_kind`, `consume_invite_quota`, `consume_invite_quota_by_email` | 007, *Rate limiting* |

## Cross-cutting

Some subjects run through several files. Start here rather than guessing which file owns them.

- **How the first platform admin is created.** 007, *Bootstrapping the first platform admin*. It is
  direct SQL and there is no route that does it.
- **Who can write `is_platform_admin`.** 002 and 008. Not `service_role`, which cannot even read
  `app_user`.
- **Peer visibility of RSVPs, attendance and part coverage.** 002 for the product argument, 008 for
  why it needed recording at the object. Narrowing any of it fails silently.
- **The performed-history freeze.** 001 for the columns, 003 for the guards, 005 for the write
  ordering, 008 for the incident. Splitting `perform_setlist`'s final UPDATE reverts a fixed bug.
- **Casting confidence ownership.** 002 for the view, 003 for the trigger, 005 for the director
  path, 006 for the member path.
- **Why the drafter gates in `core` and not in SQL.** 004. A gate moved into SQL removes the row
  before core can name the lever.
- **What the offline gate does not catch.** 004 and 008. `npm run verify` parse-validates the SQL,
  so grammar errors fail offline. A search path pin with a wrong value survives both gates and
  lands at runtime.

## The archive

`supabase/migrations/_archive/` holds the 64 migrations this baseline replaced, in their original
order and with their original headers. Go there for the full text behind anything a record only
summarises. Two cautions carried over from the records:

- An archived header can describe a shape that a later archived migration changed. `set_my_availability`
  is the clearest case: two headers call it `SECURITY INVOKER` and a third flipped it to
  `SECURITY DEFINER`. The catalog is the authority, not the earliest file that mentions the object.
- An archived comment can state reasoning that was later found wrong and corrected. Where that
  happened, the record says so at the relevant topic.
