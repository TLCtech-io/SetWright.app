// Run with: tsx test/unit/publicId.test.ts
//
// The public_id token contract: shape, validation, and generation. Pure, so the whole table
// runs here without a database.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PUBLIC_ID_RE, isPublicId, genPublicId } from "../../lib/publicId";

test("genPublicId returns a 22-char base64url token", () => {
    const id = genPublicId();
    assert.equal(id.length, 22);
    assert.ok(PUBLIC_ID_RE.test(id), `${id} should match the token format`);
    assert.ok(isPublicId(id));
});

test("genPublicId is collision-free across many calls", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => genPublicId()));
    assert.equal(ids.size, 2000, "every generated token is distinct");
});

test("isPublicId accepts a well-formed token", () => {
    assert.equal(isPublicId("AbCdEfGhIjKlMnOpQrSt-_"), true); // 20 alnum + - + _ = 22
    assert.equal(isPublicId("0123456789ABCDEFGHIJKL"), true);
});

test("isPublicId rejects the wrong length", () => {
    assert.equal(isPublicId("AbCdEfGhIjKlMnOpQrSt-"), false, "21 chars");
    assert.equal(isPublicId("AbCdEfGhIjKlMnOpQrSt-_X"), false, "23 chars");
    assert.equal(isPublicId(""), false, "empty");
});

test("isPublicId rejects a uuid (dashes are allowed but the length is wrong)", () => {
    assert.equal(isPublicId("123e4567-e89b-12d3-a456-426614174000"), false);
});

test("isPublicId rejects non-base64url characters", () => {
    assert.equal(
        isPublicId("AbCdEfGhIjKlMnOpQrSt+_"),
        false,
        "plus is not base64url",
    );
    assert.equal(
        isPublicId("AbCdEfGhIjKlMnOpQrSt/_"),
        false,
        "slash is not base64url",
    );
    assert.equal(
        isPublicId("AbCdEfGhIjKlMnOpQrSt=_"),
        false,
        "padding is stripped, never present",
    );
    assert.equal(isPublicId("AbCdEfGhIjKlMnOpQrSt _"), false, "space");
});
