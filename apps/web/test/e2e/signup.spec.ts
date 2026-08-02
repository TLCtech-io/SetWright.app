// E2E for closed public registration (phase E). PUBLIC_SIGNUP is unset in the e2e dev server, so signup
// is invite-only: /signup renders a static invite-only card (no form), and /login points to invitations
// rather than a create-an-account link. This is the anti-spam gate; reopening for the free tier is a
// PUBLIC_SIGNUP flip, so the form stays wired but hidden here.

import { expect, test } from "@playwright/test";

test("signup is invite-only: the sign-up form is hidden", async ({ page }) => {
    await page.goto("/signup");
    await expect(
        page.getByRole("heading", { name: /invite-only/i }),
    ).toBeVisible();
    // The account-creation form (and its password field) is not rendered when signup is closed.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("login shows invite-only copy, not a create-an-account link", async ({
    page,
}) => {
    await page.goto("/login");
    await expect(page.getByText(/invite-only/i)).toBeVisible();
    await expect(
        page.getByRole("link", { name: /create an ensemble/i }),
    ).toHaveCount(0);
});
