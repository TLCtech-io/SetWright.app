// Run with: tsx test/unit/publishedRefresh.mock.test.ts
//
// A published set is no longer frozen until performed: the director's order edits refresh the
// member-visible snapshot in place (syncPublishedOrder), so a finalized set tracks the director's
// changes without an unpublish/republish. The supabase adapter does the same with a guarded UPDATE of
// published_order that leaves published_at untouched; this proves the mock mirror.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    publishSetlist,
    syncPublishedOrder,
    getPublishedSet,
    getSetlistMeta,
    createSetlist,
    listSongs,
} from "../../lib/db";
import { memberSnapshotTargets } from "../../lib/sharedDraft";

const orderOf = (setlistId: string): string[] =>
    getPublishedSet(setlistId)?.songs.map((s) => s.id) ?? [];

test("a published set refreshes its member-visible order as the director edits, keeping the publish time", () => {
    const ids = listSongs()
        .slice(0, 3)
        .map((s) => s.id);
    assert.ok(ids.length >= 2, "the seed has songs to arrange");

    // Publish sl-concert (a draft) with an initial order — members now see it.
    const meta = publishSetlist("sl-concert", {
        songIds: ids,
        transitions: {},
        breaks: [],
    });
    assert.ok(meta?.publishedAt, "the set is published");
    const publishedAt = meta!.publishedAt;
    assert.deepEqual(
        orderOf("sl-concert"),
        ids,
        "members see the published order",
    );

    // The director reorders. syncPublishedOrder refreshes the member snapshot without republishing.
    const reordered = [...ids].reverse();
    syncPublishedOrder("sl-concert", {
        songIds: reordered,
        transitions: {},
        breaks: [],
    });
    assert.deepEqual(
        orderOf("sl-concert"),
        reordered,
        "the member-visible order tracks the edit",
    );
    assert.equal(
        getSetlistMeta("sl-concert")?.publishedAt,
        publishedAt,
        "the publish time is unchanged (no republish)",
    );
});

test("syncPublishedOrder is a no-op for a set that was never published", () => {
    const fresh = createSetlist("concert", "Scratch");
    assert.ok(fresh, "the scratch set is created");
    syncPublishedOrder(fresh!.id, {
        songIds: listSongs()
            .slice(0, 2)
            .map((s) => s.id),
        transitions: {},
        breaks: [],
    });
    assert.equal(
        getPublishedSet(fresh!.id),
        undefined,
        "a refresh never publishes an unpublished set; it only touches a live one",
    );
});

test("a performed set never refreshes (an immutable record)", () => {
    const before = orderOf("sl-winter"); // sl-winter is performed in the seed
    assert.ok(before.length > 0, "the performed set has a frozen order");
    syncPublishedOrder("sl-winter", {
        songIds: [...before].reverse(),
        transitions: {},
        breaks: [],
    });
    assert.deepEqual(
        orderOf("sl-winter"),
        before,
        "the performed order is untouched by a refresh",
    );
});

// memberSnapshotTargets decides which live snapshot(s) an edit refreshes. The published+shared row is
// the one that matters: a set that is BOTH published and shared must refresh BOTH, or unpublishing it
// later falls back to a stale shared draft (the divergence an adversarial review caught).
test("memberSnapshotTargets refreshes every live member snapshot, never a performed one", () => {
    const at = "2026-07-18T00:00:00.000Z";
    assert.deepEqual(
        memberSnapshotTargets({
            status: "draft",
            publishedAt: null,
            shareDraft: false,
        }),
        [],
        "nothing member-visible: no refresh",
    );
    assert.deepEqual(
        memberSnapshotTargets({
            status: "draft",
            publishedAt: at,
            shareDraft: false,
        }),
        ["published"],
        "published only",
    );
    assert.deepEqual(
        memberSnapshotTargets({
            status: "draft",
            publishedAt: null,
            shareDraft: true,
        }),
        ["shared"],
        "shared only",
    );
    assert.deepEqual(
        memberSnapshotTargets({
            status: "draft",
            publishedAt: at,
            shareDraft: true,
        }),
        ["published", "shared"],
        "published AND shared: BOTH refresh so unpublish never exposes a stale order",
    );
    assert.deepEqual(
        memberSnapshotTargets({
            status: "performed",
            publishedAt: at,
            shareDraft: true,
        }),
        [],
        "a performed set is immutable: never refreshed, even if the flags are set",
    );
});
