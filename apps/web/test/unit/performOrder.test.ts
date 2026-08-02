// Run with: tsx test/unit/performOrder.test.ts
//
// The frozen perform order resolver: scope to the set, dedupe (parity with perform_setlist's
// group-by-song_id, which the mock lacks), append omitted set songs, empty -> the route refuses.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePerformOrder } from "../../lib/performOrder";

test("resolvePerformOrder dedupes the sent order and scopes it to the set", () => {
    assert.deepEqual(
        resolvePerformOrder(["a", "a", "b"], ["a", "b"]),
        ["a", "b"],
        "a duplicate in sent is kept once",
    );
    assert.deepEqual(
        resolvePerformOrder(["a", "ghost", "b"], ["a", "b"]),
        ["a", "b"],
        "a sent id not in the set is dropped",
    );
});

test("resolvePerformOrder appends set songs the client omitted, in set order", () => {
    assert.deepEqual(
        resolvePerformOrder(["b"], ["a", "b", "c"]),
        ["b", "a", "c"],
        "omitted set songs append after the sent order",
    );
    assert.deepEqual(
        resolvePerformOrder([], ["a", "b"]),
        ["a", "b"],
        "no sent order -> the full set in set order",
    );
});

test("resolvePerformOrder yields [] for an empty/all-out-of-set input (the route then 400s)", () => {
    assert.deepEqual(resolvePerformOrder(["ghost"], []), []);
    assert.deepEqual(resolvePerformOrder([], []), []);
});
