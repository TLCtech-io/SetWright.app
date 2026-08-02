// E2E for the existing-account onramp (phase E) — a current member starting their own ensemble. A member
// holds no founding credit, so /ensembles offers them no create form. A platform admin authorizes their
// EXISTING account by email through the director console (no invite email, since they already have an
// account); the credit lands on their account, and they then self-create their ensemble. This exercises
// the create-form gate, the admin route's existing-account branch (grant_founding_credit_by_email), and
// the self-create path together. The account is created in-test, so it disturbs no shared fixture.

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { API_URL, SERVICE } from "./support";

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

test("an existing member is authorized by an admin and founds their own ensemble", async ({
    page,
}) => {
    test.slow();
    const admin = createClient(API_URL, SERVICE, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `existing-${Date.now()}@example.com`;
    // A confirmed account with no ensemble and no founding credit: in the app, but not authorized to found.
    const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password: "password123",
        email_confirm: true,
    });
    expect(createErr, createErr?.message ?? undefined).toBeFalsy();

    // 1. As that member: /ensembles offers no create form (they hold no founding credit).
    await signIn(page, email);
    await page.goto("/ensembles");
    await expect(page.getByText(/needs an invitation/i)).toBeVisible();
    await expect(page.getByLabel("New ensemble name")).toHaveCount(0);

    // 2. The admin authorizes them by email through the director console (no invite email — they already
    //    have an account). The route's existing-account branch grants the credit to their account.
    await page.context().clearCookies();
    await signIn(page, "sam@example.com");
    await page.goto("/admin/directors");
    await page.getByLabel("Director email").fill(email);
    await page.getByLabel("Director name").fill("Existing Member");
    await page.getByLabel("Ensemble name").fill("Their Choir");
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText(/already has an account/i)).toBeVisible({
        timeout: 15_000,
    });

    // 3. Back as the member: the create form now appears, and they found their own ensemble.
    await page.context().clearCookies();
    await signIn(page, email);
    await page.goto("/ensembles");
    await page.getByLabel("New ensemble name").fill("Their Choir");
    await page.getByRole("button", { name: "Create ensemble" }).click();
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\/dashboard/, {
        timeout: 15_000,
    });
});
