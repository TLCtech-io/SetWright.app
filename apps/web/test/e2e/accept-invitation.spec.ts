// E2E for the consent step. A seat no longer binds itself: /auth/confirm establishes a session and
// nothing more, and the person named on the seat decides at /auth/invitations.
//
// Named to sort first. The suite runs on one worker in file order against a shared database, and
// email-change.spec renames rae@example.com, who is the seeded invitee this spec needs.
//
// Rae holds a pending invitation to Harmony Collective (seeded as Cleo's seat) and already directs an
// ensemble of her own, which is what makes her the useful fixture here: she can sign in with a
// password, never touch a confirm link, and still have to be told an invitation is waiting.

import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

test("a password sign-in is told an invitation is waiting, and joining is a choice", async ({
    page,
}) => {
    await signIn(page, "rae@example.com");

    // The entry point. Signing in with a password goes nowhere near a confirm link, so without this
    // the invitation would be invisible to her.
    await page.goto("/ensembles");
    await expect(page.getByText(/invitation.*waiting/i)).toBeVisible();
    await page.getByRole("link", { name: /decide whether to join/i }).click();
    await expect(page).toHaveURL(/\/auth\/invitations$/);

    // The screen names the ensemble and the seat. She can read neither directly: she holds no member
    // row there, so this is the definer reader's output, not a table she has access to.
    await expect(page.getByText("Harmony Collective, as Cleo")).toBeVisible();

    await page.getByRole("button", { name: "Join" }).click();
    // Landing inside the ensemble, not on a specific page: accept sends everyone to the dashboard and
    // the proxy bounces a non-director to their own space, which is what happens here. Cleo's seat is
    // a plain member seat, so she ends up on /me.
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\//, {
        timeout: 15_000,
    });

    // Accepted invitations stop being offered.
    await page.goto("/auth/invitations");
    await expect(page.getByText(/nothing is waiting/i)).toBeVisible();
});
