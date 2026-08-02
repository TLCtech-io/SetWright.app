// Run with: tsx test/unit/ensemblePath.test.ts
//
// The proxy's member role gate, extracted and tested apart from the Next/Supabase middleware.
// Pure and path-only, so the whole decision table runs here. The URL now carries public_id
// tokens, so the event-detail exception matches a token, not a uuid.

import { test } from "node:test";
import assert from "node:assert/strict";

import { memberBounceTarget } from "../../lib/ensemblePath";

const ENS = "AbCdEfGhIjKlMnOpQrSt12"; // a 22-char ensemble token
const EVT = "Ev3ntT0k3nAbCdEfGhIjKl"; // a 22-char event token
const me = `/e/${ENS}/me`;

test("a member is not bounced from their own surface", () => {
    assert.equal(memberBounceTarget(me, ENS), null);
});

test("a member is not bounced from a sub-path of their own surface", () => {
    assert.equal(memberBounceTarget(`${me}/parts`, ENS), null);
    assert.equal(memberBounceTarget(`${me}/schedule`, ENS), null);
});

test("a member is bounced from a director console page", () => {
    assert.equal(memberBounceTarget(`/e/${ENS}/dashboard`, ENS), me);
    assert.equal(memberBounceTarget(`/e/${ENS}/songs`, ENS), me);
    assert.equal(memberBounceTarget(`/e/${ENS}/roster`, ENS), me);
});

test("a member is not bounced from the shared event-detail page (exact token segment)", () => {
    assert.equal(memberBounceTarget(`/e/${ENS}/events/${EVT}`, ENS), null);
});

test("a member IS bounced from the events list (not the detail page)", () => {
    assert.equal(memberBounceTarget(`/e/${ENS}/events`, ENS), me);
});

test("a member is bounced from /events/new (not a token)", () => {
    assert.equal(memberBounceTarget(`/e/${ENS}/events/new`, ENS), me);
});

test("a member is bounced from a deeper event sub-path (roster)", () => {
    assert.equal(memberBounceTarget(`/e/${ENS}/events/${EVT}/roster`, ENS), me);
});

test("the /me prefix is not matched as a substring of another segment", () => {
    // A page like /me-something must not be read as the member surface.
    assert.equal(memberBounceTarget(`/e/${ENS}/members`, ENS), me);
});
