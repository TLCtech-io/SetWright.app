// Run with: tsx test/unit/safeNext.test.ts
//
// The login ?next return-target guard. Prefix checks alone are defeated by ASCII tab/newline/CR
// (WHATWG URL parsing strips them, so "/\t/evil.com" collapses to the protocol-relative
// "//evil.com"), so safeNext canonicalizes and requires the value to stay same-origin.

import { test } from "node:test";
import assert from "node:assert/strict";

import { safeNext } from "../../lib/safeNext";

test("safeNext: rejects every off-site redirect vector", () => {
    assert.equal(safeNext("/\t/evil.com"), "/", "ASCII tab bypass -> rejected");
    assert.equal(safeNext("/\n/evil.com"), "/", "newline -> rejected");
    assert.equal(safeNext("/\r/evil.com"), "/", "carriage return -> rejected");
    assert.equal(safeNext("//evil.com"), "/", "protocol-relative -> rejected");
    assert.equal(safeNext("/\\evil.com"), "/", "backslash -> rejected");
    assert.equal(safeNext("https://evil.com"), "/", "absolute url -> rejected");
    assert.equal(safeNext("javascript:alert(1)"), "/", "scheme -> rejected");
    assert.equal(safeNext(undefined), "/", "undefined -> /");
    assert.equal(safeNext(""), "/", "empty -> /");
});

test("safeNext: keeps a legitimate app-relative return target", () => {
    assert.equal(
        safeNext("/e/tok/events/abc?x=1"),
        "/e/tok/events/abc?x=1",
        "deep link with query kept",
    );
    assert.equal(safeNext("/"), "/", "root kept");
    assert.equal(
        safeNext("/e/tok/setlist/xyz#seam"),
        "/e/tok/setlist/xyz#seam",
        "hash preserved",
    );
});
