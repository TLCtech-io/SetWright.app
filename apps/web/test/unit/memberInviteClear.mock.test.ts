// Run with: tsx test/unit/memberInviteClear.mock.test.ts
//
// M2 parity: deactivating a seat must revoke its pending invite (mock mirror of migration 052's
// set_member_status delete). A removed seat that kept a claimable invite would bind the invitee onto
// an inactive row (auth_member_tier requires active), stranding them — the archive-then-claim dead end.

import { test } from "node:test";
import assert from "node:assert/strict";

import { inviteMember, setMemberStatus, getMember } from "../../lib/db";

test("setMemberStatus(inactive) clears a pending invite on the seat", () => {
    // m5 (Fiona) is an unclaimed active member with no invite yet.
    const invited = inviteMember("m5", "fiona@example.com", "hash");
    assert.ok(invited.ok, "the invite is recorded");
    assert.equal(
        getMember("m5")?.inviteEmail,
        "fiona@example.com",
        "the pending invite email is set",
    );

    const deactivated = setMemberStatus("m5", "inactive");
    assert.ok(deactivated.ok, "the deactivation succeeds");
    assert.equal(
        getMember("m5")?.inviteEmail,
        null,
        "deactivating the seat revoked its pending invite",
    );
});
