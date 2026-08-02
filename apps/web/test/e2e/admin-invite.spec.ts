// E2E for the platform-admin director-invite console (phase D) — the full invite-first happy path through
// the real UI. A platform admin (sam) opens /admin/directors, fills the invite form, and submits; the
// route re-checks admin, rate-limits, sends the invite, and grants the founding credit. The invited
// director then accepts the emailed link and lands inside their freshly seeded ensemble. This exercises
// phase D (the admin surface + route) end to end with phase C (the confirm-route seed) and the 057 credit.
// The deny direction (a non-admin at /admin/directors) is covered by admin-gate.spec.

import { expect, test, type Page } from "@playwright/test";
import { inviteTokenHash } from "./support";

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

test("a platform admin invites a director, who accepts and lands in their seeded ensemble", async ({
    page,
}) => {
    test.slow(); // real email send + Mailpit poll + a cold confirm render
    const email = `d-invite-${Date.now()}@example.com`;

    // The admin invites through the real console.
    await signIn(page, "sam@example.com"); // seeded platform admin
    await page.goto("/admin/directors");
    await expect(
        page.getByRole("heading", { name: /invite a director/i }),
    ).toBeVisible();
    await page.getByLabel("Director email").fill(email);
    await page.getByLabel("Director name").fill("Dana");
    await page.getByLabel("Ensemble name").fill("Invited Choir");
    await page.getByRole("button", { name: "Send invite" }).click();
    // The route returns ok only after BOTH the invite send and the founding-credit grant succeed, so this
    // notice is proof the whole admin action worked.
    await expect(page.getByText(/invitation sent/i)).toBeVisible({
        timeout: 15_000,
    });

    // The invited director accepts from a clean session (a different person, a different browser): drop the
    // admin's cookies, then follow the emailed link. /auth/confirm verifies the token, seeds the ensemble
    // (consuming the granted credit), and lands them on /auth/welcome carrying the new ensemble's token —
    // the ?e token only appears if create_ensemble_seeded actually ran.
    await page.context().clearCookies();
    const tokenHash = await inviteTokenHash(email);
    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=invite`);
    await expect(page).toHaveURL(/\/auth\/welcome\?e=[A-Za-z0-9_-]{22}/, {
        timeout: 15_000,
    });
});
