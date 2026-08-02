// Run with: tsx test/unit/welcomeDest.test.ts
//
// The /auth/welcome post-password destination. The reset (recovery) branch is the one that regressed:
// an existing user who resets their password has no pending seat, so with no ensemble token they must
// fall back to the home resolver, NOT the "you have no access" page (which is for a stranded invite).

import { test } from "node:test";
import assert from "node:assert/strict";

import { welcomeDest } from "../../lib/welcomeDest";

test("with an ensemble token, go to that dashboard (reset or not)", () => {
    assert.equal(welcomeDest("tok", false), "/e/tok/dashboard");
    assert.equal(welcomeDest("tok", true), "/e/tok/dashboard");
});

test("a password reset with no ensemble falls back to the home resolver, not no-access", () => {
    assert.equal(welcomeDest(null, true), "/");
});

test("a fresh invite that bound no seat lands on the no-access page", () => {
    assert.equal(welcomeDest(null, false), "/auth/no-access");
});
