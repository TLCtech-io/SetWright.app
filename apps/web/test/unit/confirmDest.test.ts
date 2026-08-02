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
