// E2E for the auth seam the integration suite can't reach: the real login
// cookie round-trip (browser sets the session -> the server reads it and serves the
// app, RLS-scoped to that user) and sign-out. Runs against a supabase-mode dev server.

import { expect, test } from "@playwright/test";

test("sign in reaches the app and sign out returns to login", async ({
    page,
}) => {
    // Unauthenticated: the proxy guards every page.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);

    await page.fill('input[type="email"]', "ana@example.com");
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');

    // The session cookie is set; the server now reads it and the home redirect lands
    // inside the active ensemble on the Dashboard (the director's home).
    await expect(page).toHaveURL(/\/e\/[^/]+\/dashboard/);
    // The nav is ensemble-scoped; following Roster reads through RLS as Ana — her
    // ensemble's members are there.
    await page.locator("nav.nav").getByRole("link", { name: "Roster" }).click();
    await expect(page).toHaveURL(/\/e\/[^/]+\/roster/);
    await expect(page.getByText("Cleo")).toBeVisible();

    // Identity and sign-out live behind the nav avatar's account menu. Opening it shows
    // Ana's email (passed server-side from the session), and sign-out returns to login.
    // The sign-out control carries role="menuitem", so target it by class, not button role.
    await page.click("button.nav-avatar");
    await expect(page.getByText("ana@example.com")).toBeVisible();
    await page.click("button.account-item.danger");
    await expect(page).toHaveURL(/\/login$/);
});

test("bad credentials are rejected", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', "ana@example.com");
    await page.fill('input[type="password"]', "not-the-password");
    await page.click('button[type="submit"]');
    await expect(page.locator(".login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
});

test("unauthenticated API requests get a 401, not a login redirect", async ({
    request,
}) => {
    // The proxy turns away an unauthenticated /api/* call with a JSON 401 an API client can act
    // on, rather than a 307 to the HTML login page (which the pages get). Data routes now live
    // under /api/e/:ensembleId; the proxy 401s the whole /api surface before routing.
    const res = await request.get(
        "/api/e/00000000-0000-0000-0000-000000000000/songs",
        { maxRedirects: 0 },
    );
    expect(res.status()).toBe(401);
});
