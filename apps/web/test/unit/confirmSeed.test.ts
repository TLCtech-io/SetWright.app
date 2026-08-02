// Run with: tsx test/unit/confirmSeed.test.ts
//
// The /auth/confirm seed gate: which verified link types may create the ensemble the user typed.
// Security-relevant — a director invite must be able to seed (it is the admin on-ramp), a member invite
// must not (it carries no pending name), and a recovery link must never seed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pendingSeedApplies } from "../../lib/confirmSeed";

test("a director invite with a pending name seeds", () => {
    assert.equal(pendingSeedApplies("invite", "The Choir"), true);
});

test("the self-signup confirmation types are seedable (the predicate admits them)", () => {
    assert.equal(pendingSeedApplies("signup", "The Choir"), true);
    assert.equal(pendingSeedApplies("email", "The Choir"), true);
    assert.equal(pendingSeedApplies("magiclink", "The Choir"), true);
});

test("recovery and email-change never seed, even with a pending name", () => {
    assert.equal(pendingSeedApplies("recovery", "The Choir"), false);
    assert.equal(pendingSeedApplies("email_change", "The Choir"), false);
});

test("an unknown link type fails closed (allowlist, not denylist)", () => {
    assert.equal(pendingSeedApplies("some_future_type", "The Choir"), false);
});

test("no pending name never seeds (a plain member invite or a returning sign-in)", () => {
    assert.equal(pendingSeedApplies("invite", undefined), false);
    assert.equal(pendingSeedApplies("invite", null), false);
    assert.equal(pendingSeedApplies("invite", ""), false);
    assert.equal(pendingSeedApplies("magiclink", undefined), false);
});

test("the seed reads pending_ensemble_name alone, so a member invite cannot reach it", () => {
    // sendMemberInvite stamps invited_ensemble_name so the invite email can name the group. That
    // key must stay inert here: the gate takes the pending name as its argument and the route
    // reads only user_metadata.pending_ensemble_name, so a singer's invite never seeds an ensemble.
    // Pinned rather than left incidental, because the two keys are one careless rename apart.
    const memberInviteMetadata: Record<string, string> = {
        invite_kind: "member",
        invited_ensemble_name: "Riverside Singers",
        invited_by_name: "Dana",
    };
    assert.equal(
        pendingSeedApplies(
            "invite",
            memberInviteMetadata.pending_ensemble_name,
        ),
        false,
    );
});
