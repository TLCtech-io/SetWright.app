// Run with: npm test -w apps/web  (tsx test/unit/limits.test.ts)
//
// The request-supplied id-list cap (B5): coerceIdList filters to strings and bounds the count.

import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceIdList, MAX_SET_IDS } from "../../lib/limits";

test("non-arrays become an empty list", () => {
    assert.deepEqual(coerceIdList(undefined), []);
    assert.deepEqual(coerceIdList(null), []);
    assert.deepEqual(coerceIdList("a"), []);
    assert.deepEqual(coerceIdList({ 0: "a" }), []);
});

test("only string entries survive", () => {
    assert.deepEqual(coerceIdList(["a", 1, null, "b", {}, "c"]), [
        "a",
        "b",
        "c",
    ]);
});

test("the list is capped at MAX_SET_IDS", () => {
    const over = Array.from({ length: MAX_SET_IDS + 50 }, (_, i) => `id-${i}`);
    const out = coerceIdList(over);
    assert.equal(out.length, MAX_SET_IDS);
    assert.equal(out[0], "id-0");
    assert.equal(out[MAX_SET_IDS - 1], `id-${MAX_SET_IDS - 1}`);
});

test("a list at the cap is unchanged", () => {
    const exact = Array.from({ length: MAX_SET_IDS }, (_, i) => `id-${i}`);
    assert.equal(coerceIdList(exact).length, MAX_SET_IDS);
});
