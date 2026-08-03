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

test("a stranded invite with an invitation waiting goes to the accept screen, not no-access", () => {
    // Since the accept step landed, an invited person binds no seat at confirm, so they arrive here
    // with no token and a decision still to make. Sending them to no-access would tell someone who
    // does have an invitation that they have none.
    assert.equal(welcomeDest(null, false, true), "/auth/invitations");
});

test("a password reset is never interrupted by a pending invitation", () => {
    // Resetting a password is an unrelated errand. The invitation keeps until they go looking, so the
    // reset branch is checked before the invitation branch.
    assert.equal(welcomeDest(null, true, true), "/");
});

test("an ensemble token still wins over a pending invitation", () => {
    assert.equal(welcomeDest("tok", false, true), "/e/tok/dashboard");
});
