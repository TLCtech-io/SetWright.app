-- Member console Phase 5a: publish a set to members.
--
-- A set becomes visible to members only when the director publishes it, OR once it has been
-- performed (a gig that happened is always visible). Publishing freezes the current draft order
-- into published_order (a jsonb snapshot: { songIds, transitions, breaks }) so the member call
-- sheet reads a stable set, not a live re-draft. published_at is the publish time and the
-- visibility gate. The two move together: both null (unpublished) or both set (published).
--
-- The read gate is tightened here too: today setlist / setlist_item / setlist_break are readable
-- by any active member. After this, a non-director reads only a published-or-performed set; a
-- director still reads everything. Validate under the live stack (verify:full) before relying on it.

alter table setlist
add column published_at    timestamptz,
add column published_order jsonb,
add constraint setlist_published_pair
check ((published_at is null) = (published_order is null));

-- setlist: any read still requires active membership of THIS row's ensemble (the tenant boundary,
-- auth_member_tier(ensemble_id) is not null). Within the tenant, a director reads all; a member reads
-- only a published or performed set. The membership check must gate EVERY branch, or a bare
-- published/performed predicate would match rows of every ensemble and leak across tenants.
drop policy setlist_read on setlist;
create policy setlist_read on setlist
for select using (
    auth_member_tier(ensemble_id) is not null
    and (
        auth_member_tier(ensemble_id) = 'director'
        or published_at is not null
        or status = 'performed'
    )
);

-- setlist_item: same tenant guard, then readable when the parent setlist is (a director sees all; a
-- member sees the items of a published or performed set). The subquery names the parent's gate
-- explicitly rather than leaning on the setlist policy composing through.
drop policy setlist_item_read on setlist_item;
create policy setlist_item_read on setlist_item
for select using (
    auth_member_tier(ensemble_id) is not null
    and (
        auth_member_tier(ensemble_id) = 'director'
        or exists (
            select 1 from setlist s
            where s.ensemble_id = setlist_item.ensemble_id
            and s.id = setlist_item.setlist_id
            and (s.published_at is not null or s.status = 'performed')
        )
    )
);

-- setlist_break: same tenant guard + parent-gated read as setlist_item.
drop policy setlist_break_read on setlist_break;
create policy setlist_break_read on setlist_break
for select using (
    auth_member_tier(ensemble_id) is not null
    and (
        auth_member_tier(ensemble_id) = 'director'
        or exists (
            select 1 from setlist s
            where s.ensemble_id = setlist_break.ensemble_id
            and s.id = setlist_break.setlist_id
            and (s.published_at is not null or s.status = 'performed')
        )
    )
);
