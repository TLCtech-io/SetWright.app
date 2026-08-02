// Run with: tsx test/unit/adminPath.test.ts
//
// The proxy's platform-admin perimeter gate, extracted and tested apart from the Next/Supabase
// middleware. Path-only, so the whole decision table runs here: which paths the gate covers, and
// (the security-relevant part) which lookalikes it must NOT catch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isAdminPath } from "../../lib/adminPath";

test("the admin console root and its sub-pages are gated", () => {
    assert.equal(isAdminPath("/admin"), true);
    assert.equal(isAdminPath("/admin/"), true);
    assert.equal(isAdminPath("/admin/directors"), true);
    assert.equal(isAdminPath("/admin/directors/new"), true);
});

test("the admin API root and its endpoints are gated", () => {
    assert.equal(isAdminPath("/api/admin"), true);
    assert.equal(isAdminPath("/api/admin/"), true);
    assert.equal(isAdminPath("/api/admin/directors"), true);
});

test("a lookalike segment is NOT gated (no open prefix match)", () => {
    // /administrator must not be read as /admin; /api/administer must not be read as /api/admin.
    assert.equal(isAdminPath("/administrator"), false);
    assert.equal(isAdminPath("/adminfoo"), false);
    assert.equal(isAdminPath("/api/administer"), false);
    assert.equal(isAdminPath("/api/adminfoo/x"), false);
});

test("ordinary app and API paths are not gated", () => {
    assert.equal(isAdminPath("/"), false);
    assert.equal(isAdminPath("/e/AbCdEfGhIjKlMnOpQrSt12/dashboard"), false);
    assert.equal(isAdminPath("/api/e/AbCdEfGhIjKlMnOpQrSt12/songs"), false);
    assert.equal(isAdminPath("/login"), false);
    assert.equal(isAdminPath("/signup"), false);
});
