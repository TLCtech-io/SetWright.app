// Run with: tsx test/unit/rsvpVersion.mock.test.ts
//
// Bug2 parity: a member's self-RSVP must advance the event's optimistic-concurrency version, so a
// director's guarded bulk RSVP save (set_availability guards on event.updated_at) detects the
// change and conflicts instead of silently overwriting it. The supabase RPC bumps event.updated_at;
// the mock bumps its version counter to match.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getEvent, setMyAvailability } from "../../lib/db";

test("setMyAvailability advances the event version (Bug2 parity)", () => {
    const before = getEvent("church")?.version;
    assert.ok(before !== undefined, "seeded event exists");
    setMyAvailability("church", "in");
    const after = getEvent("church")?.version;
    assert.notEqual(
        after,
        before,
        "the event version advanced after a member RSVP, so a stale director token now conflicts",
    );
});
