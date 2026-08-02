// Run with: npm test -w apps/web  (tsx test/unit/csrf.test.ts)
//
// The proxy's CSRF same-origin decision, tested apart from the Next/Supabase
// middleware. Pure and header-only, so the whole decision table is exercised here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { crossOriginWriteRefused as refused } from "../../lib/csrf";

const HOST = "app.example.com";
const base = {
    method: "POST",
    pathname: "/api/x",
    origin: null,
    referer: null,
    host: HOST,
    forwardedProto: null,
};

test("a cross-origin mutating /api request is refused", () => {
    assert.equal(refused({ ...base, origin: "https://evil.com" }), true);
});

test("a same-host request is allowed (host header compare, not nextUrl.origin)", () => {
    // The regression: comparing against nextUrl.origin rejected a same-origin sign-out behind a
    // proxy. The Host header reflects the browser's view on both sides, so this must pass.
    assert.equal(refused({ ...base, origin: `https://${HOST}` }), false);
    assert.equal(
        refused({ ...base, origin: `http://${HOST}` }),
        false,
        "scheme not checked without x-forwarded-proto",
    );
});

test("an absent Origin/Referer is allowed (same-origin or a non-browser client)", () => {
    assert.equal(refused({ ...base }), false);
});

test("Referer is the fallback when Origin is absent", () => {
    assert.equal(refused({ ...base, referer: "https://evil.com/page" }), true);
    assert.equal(refused({ ...base, referer: `https://${HOST}/page` }), false);
});

test("a present-but-unparseable origin is refused", () => {
    assert.equal(refused({ ...base, origin: "not a url" }), true);
});

test("scheme is checked when the proxy declares it (x-forwarded-proto)", () => {
    // In production behind a TLS proxy, a same-host http origin against an https deployment is caught.
    assert.equal(
        refused({ ...base, origin: `http://${HOST}`, forwardedProto: "https" }),
        true,
    );
    assert.equal(
        refused({
            ...base,
            origin: `https://${HOST}`,
            forwardedProto: "https",
        }),
        false,
    );
});

test("a same-host different-port origin is still cross-origin", () => {
    assert.equal(
        refused({
            ...base,
            host: `${HOST}:443`,
            origin: `https://${HOST}:8443`,
        }),
        true,
    );
});

test("safe methods are never refused, even cross-origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
        assert.equal(
            refused({ ...base, method, origin: "https://evil.com" }),
            false,
            method,
        );
    }
});

test("/auth/signout is protected (a mutating route outside /api)", () => {
    assert.equal(
        refused({
            ...base,
            pathname: "/auth/signout",
            origin: "https://evil.com",
        }),
        true,
    );
    // ...but a same-host sign-out is allowed (the regression that broke E2E sign-out).
    assert.equal(
        refused({
            ...base,
            pathname: "/auth/signout",
            origin: `https://${HOST}`,
        }),
        false,
    );
});

test("/auth/confirm (a GET magic-link landing) is not blocked", () => {
    assert.equal(
        refused({
            ...base,
            method: "GET",
            pathname: "/auth/confirm",
            origin: "https://mail.google.com",
        }),
        false,
    );
});

test("other non-protected paths are never refused here", () => {
    assert.equal(
        refused({ ...base, pathname: "/login", origin: "https://evil.com" }),
        false,
    );
});
