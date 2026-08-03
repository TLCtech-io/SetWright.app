// Run with: tsx test/unit/confirmDest.test.ts
//
// /auth/confirm destination branching by link type: invite/recovery -> set-a-password screen,
// magic-link/signup -> straight in. Invite acceptance and password reset are the product's front
// door, so a regression here strands users on the wrong screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmDestination } from "../../lib/confirmDest";

test("invite/recovery land on /auth/welcome to set a password", () => {
    assert.equal(confirmDestination("invite", "tok"), "/auth/welcome?e=tok");
    assert.equal(
        confirmDestination("invite", null),
        "/auth/welcome",
        "no ensemble token -> no ?e",
    );
    assert.equal(
        confirmDestination("recovery", "tok"),
        "/auth/welcome?e=tok&reset=1",
        "recovery carries reset=1",
    );
    assert.equal(confirmDestination("recovery", null), "/auth/welcome?reset=1");
});

test("magic-link/signup go to the ensemble dashboard, else the no-access page", () => {
    assert.equal(confirmDestination("magiclink", "tok"), "/e/tok/dashboard");
    assert.equal(confirmDestination("signup", "tok"), "/e/tok/dashboard");
    assert.equal(
        confirmDestination("magiclink", null),
        "/auth/no-access",
        "no ensemble -> no-access page",
    );
});

test("email change lands back on the profile with an acknowledgement flag", () => {
    // GoTrue names the confirm type email_change; the generic email is accepted too so a link built
    // with either still routes to the profile instead of falling through to the dashboard.
    assert.equal(
        confirmDestination("email_change", "tok"),
        "/e/tok/me/profile?email=changed",
    );
    assert.equal(
        confirmDestination("email", "tok"),
        "/e/tok/me/profile?email=changed",
    );
    assert.equal(
        confirmDestination("email_change", null),
        "/?email=changed",
        "no ensemble token -> home resolver still flags it",
    );
});

test("a magic link with an invitation waiting goes to the accept screen", () => {
    // Nothing binds at confirm any more, so a magic-link sign-in for an invited address arrives with
    // no token. Without the flag it would land on no-access, which is the wrong story to tell someone
    // who does have an invitation waiting.
    assert.equal(
        confirmDestination("magiclink", null, true),
        "/auth/invitations",
    );
    assert.equal(
        confirmDestination("magiclink", null, false),
        "/auth/no-access",
        "no invitation waiting keeps the existing no-access destination",
    );
});

test("an invite link carries the pending flag through the password step", () => {
    // invite still goes to /auth/welcome first, because the account has no usable password yet. The
    // flag rides along so the welcome screen knows where to send them afterwards.
    assert.equal(
        confirmDestination("invite", null, true),
        "/auth/welcome?invited=1",
    );
    assert.equal(
        confirmDestination("invite", null, false),
        "/auth/welcome",
        "no invitation waiting adds no flag",
    );
});

test("an ensemble token suppresses the pending flag: they already have somewhere to land", () => {
    assert.equal(confirmDestination("invite", "tok", true), "/auth/welcome?e=tok");
    assert.equal(confirmDestination("signup", "tok", true), "/e/tok/dashboard");
});

test("recovery and email change are never rerouted to the accept screen", () => {
    assert.equal(
        confirmDestination("recovery", null, true),
        "/auth/welcome?reset=1",
    );
    assert.equal(
        confirmDestination("email_change", null, true),
        "/?email=changed",
    );
});
