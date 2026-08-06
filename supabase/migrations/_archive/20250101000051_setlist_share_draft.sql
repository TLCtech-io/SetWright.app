-- Member draft preview: share a live (non-frozen) draft with members.
--
-- Distinct from publish. Publish FREEZES the order into published_order and is the final member
-- record; sharing a draft is opt-in, reversible, and stays current as the director edits.
-- share_draft is the member-visibility gate; draft_order is the order snapshot (jsonb:
-- { songIds, transitions, breaks }) the director's edits keep fresh (auto-resynced on each order
-- change). A member reads that stable snapshot, never running the drafter, which would otherwise
-- expose the whole event pool (every RSVP, the full casting map). Both columns ride the setlist
-- row, so a member reads only setlist, never setlist_item / setlist_break, for a draft.
--
-- Validate under the live stack (verify:full) before relying on the RLS change.

alter table setlist
add column share_draft  boolean not null default false,
add column draft_order  jsonb;

-- setlist read: still requires active membership of THIS row's ensemble (the tenant boundary,
-- auth_member_tier(ensemble_id) is not null). Within the tenant, a director reads all; a member now
-- reads a published, performed, OR shared-draft set. The membership check must gate EVERY branch, or
-- the bare share_draft predicate would match rows of every ensemble and leak across tenants (the same
-- pitfall migration 041 calls out). draft_order rides this row, so setlist_read covers it with no
-- separate policy; setlist_item / setlist_break stay gated to published-or-performed (a draft is not
-- read through them), so no member sees draft item/break rows.
drop policy setlist_read on setlist;
create policy setlist_read on setlist
for select using (
    auth_member_tier(ensemble_id) is not null
    and (
        auth_member_tier(ensemble_id) = 'director'
        or published_at is not null
        or status = 'performed'
        or share_draft
    )
);
