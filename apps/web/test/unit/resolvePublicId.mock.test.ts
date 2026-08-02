// Run with: tsx test/unit/resolvePublicId.mock.test.ts
//
// The mock repository's public_id resolver. The mock has no separate token, so the seed id
// doubles as the public_id: resolving a known id returns it, an unknown one returns null, and a
// token of the wrong kind returns null (each entity looks only in its own store).

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePublicId } from "../../lib/db";

test("resolvePublicId returns the id for a seeded row of each kind", () => {
    assert.equal(resolvePublicId("song", "lean"), "lean");
    assert.equal(resolvePublicId("member", "m1"), "m1");
    assert.equal(resolvePublicId("event", "concert"), "concert");
    assert.equal(resolvePublicId("setlist", "sl-winter"), "sl-winter");
    assert.equal(resolvePublicId("program", "pg-spring"), "pg-spring");
});

test("resolvePublicId returns null for an unknown token", () => {
    assert.equal(resolvePublicId("song", "no-such-song"), null);
    assert.equal(resolvePublicId("event", "no-such-event"), null);
});

test("resolvePublicId is kind-scoped: a token of the wrong kind does not resolve", () => {
    // 'lean' is a song, not an event; 'concert' is an event, not a program.
    assert.equal(resolvePublicId("event", "lean"), null);
    assert.equal(resolvePublicId("program", "concert"), null);
});
