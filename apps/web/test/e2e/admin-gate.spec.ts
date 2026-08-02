// E2E for the platform-admin perimeter gate (proxy.ts). The admin console at /admin and its API under
// /api/admin are reachable only by a platform admin; a signed-in non-admin is turned away by the proxy
// before any route runs — a redirect home for a page, a 403 JSON for the API. The gate lives in
// middleware, so it is provable before the admin PAGE exists (that lands in a later phase): a non-admin
// is bounced, and the admin fixture (sam) instead passes the gate and meets the not-yet-built route's
// own 404. sam belongs to no ensemble, so signing in as sam shifts no other test's active ensemble.

import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

const PROBE = "/api/admin/__gate_probe__"; // no such route exists; the gate's decision is what differs

test("a non-admin is redirected away from an /admin page", async ({ page }) => {
    await signIn(page, "ben@example.com"); // ben is a plain member, never a platform admin
    await page.goto("/admin/directors");
    // The proxy bounces to /, which resolves to ben's own home — anywhere but the admin console.
    await expect(page).not.toHaveURL(/\/admin/, { timeout: 15_000 });
});

test("a non-admin gets a 403 on the admin API", async ({ page }) => {
    await signIn(page, "ben@example.com");
    const res = await page.request.get(PROBE, { maxRedirects: 0 });
    expect(res.status()).toBe(403);
});

test("a platform admin passes the gate (meets the route, not a 403)", async ({
    page,
}) => {
    await signIn(page, "sam@example.com"); // sam is flagged is_platform_admin in the seed
    const res = await page.request.get(PROBE, { maxRedirects: 0 });
    // Not denied by the gate. No such route exists yet, so routing itself answers 404 — proof the gate
    // let the admin through rather than short-circuiting with a 403.
    expect(res.status()).toBe(404);
});
