// Run with: tsx test/unit/sheetOrder.test.ts
//
// The print sheet's ?order= resolution, extracted from the sheet page. Pure: token -> uuid
// mapping, drop-unknown, dedupe, cap, and whitespace handling.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveOrderTokens } from "../../lib/sheetOrder";

const byToken = new Map([
    ["tokA", "uA"],
    ["tokB", "uB"],
    ["tokC", "uC"],
]);
const inSet = new Set(["uA", "uB", "uC"]);

test("an absent param resolves to nothing", () => {
    assert.deepEqual(resolveOrderTokens(undefined, byToken, inSet, 10), []);
    assert.deepEqual(resolveOrderTokens(null, byToken, inSet, 10), []);
    assert.deepEqual(resolveOrderTokens("", byToken, inSet, 10), []);
});

test("tokens map to uuids in the requested order", () => {
    assert.deepEqual(resolveOrderTokens("tokB,tokA,tokC", byToken, inSet, 10), [
        "uB",
        "uA",
        "uC",
    ]);
});

test("surrounding whitespace is trimmed", () => {
    assert.deepEqual(resolveOrderTokens(" tokB , tokA ", byToken, inSet, 10), [
        "uB",
        "uA",
    ]);
});

test("an unknown token is dropped", () => {
    assert.deepEqual(resolveOrderTokens("tokB,tokZ,tokA", byToken, inSet, 10), [
        "uB",
        "uA",
    ]);
});

test("a token whose uuid is not in the set is dropped", () => {
    const smaller = new Set(["uA", "uB"]);
    assert.deepEqual(
        resolveOrderTokens("tokA,tokC,tokB", byToken, smaller, 10),
        ["uA", "uB"],
    );
});

test("a repeated token is deduped (a song prints once)", () => {
    assert.deepEqual(resolveOrderTokens("tokA,tokA,tokB", byToken, inSet, 10), [
        "uA",
        "uB",
    ]);
});

test("the result is capped, counting only kept entries", () => {
    assert.deepEqual(resolveOrderTokens("tokA,tokB,tokC", byToken, inSet, 2), [
        "uA",
        "uB",
    ]);
    // Unknown/out-of-set tokens do not consume the cap: two valid ones still come through.
    assert.deepEqual(
        resolveOrderTokens("tokZ,tokA,tokZ,tokB,tokC", byToken, inSet, 2),
        ["uA", "uB"],
    );
});
