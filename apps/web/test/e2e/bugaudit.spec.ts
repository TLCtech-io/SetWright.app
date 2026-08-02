// E2E for the bug-audit fixes that only a browser can exercise. Runs in CI against a live
// supabase-mode stack with the local seed (ana@example.com is the director of Ensemble A).
// Authored to run in CI; it needs the seed + a browser, so it is not part of the offline gate.

import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/e\/[^/]+\//);
}

// H1/H2: the RSVP editor's optimistic-concurrency token is re-seeded from the version prop, so
// saving the event details first (which bumps event.updated_at + router.refresh) no longer makes the
// following RSVP save false-conflict ("changed somewhere else") until a full reload.
test("save event details, then save RSVPs on the same page, without a false conflict", async ({
    page,
}) => {
    // The heaviest e2e in the suite: sign in, open the events list, open the event, save details, wait
    // for the RSC refresh, then save RSVPs — several first renders before the assertion under test. On a
    // cold or loaded CI runner those renders can eat the default 30s budget before the flow finishes (a
    // CI run timed out clicking the event link on line 24, well before the concurrency check). test.slow()
    // triples the budget so runner slowness never reads as a failure; the assertions are unchanged.
    test.slow();
    await signIn(page, "ana@example.com");

    // Open the seeded Summer concert event.
    await page.locator("nav.nav").getByRole("link", { name: "Events" }).click();
    await expect(page).toHaveURL(/\/events$/);
    await page.getByRole("link", { name: /Summer concert/i }).click();
    await expect(page).toHaveURL(/\/events\/[A-Za-z0-9_-]{22}$/);

    // Save the event details (bumps event.updated_at + refreshes, which re-renders RsvpEditor with a
    // new version prop — the exact trigger for the stale-token bug).
    await page
        .locator("button.section-toggle", { hasText: "Event details" })
        .click();
    await page.getByLabel("Venue").fill("Memorial Hall (updated)");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    // Let EventForm's router.refresh() re-render RsvpEditor with the new version (which re-seeds its
    // token) before we touch the RSVPs — a human pauses here; the test must wait for the RSC re-fetch
    // to settle, or it races the reseed. (Production build, no HMR, so networkidle is reliable.)
    await page.waitForLoadState("networkidle");

    // Now, WITHOUT reloading, toggle an RSVP and save. The re-seed must let this succeed.
    await page.locator("button.section-toggle", { hasText: "RSVPs" }).click();
    await page.locator("button.whatif-toggle.in").first().click();
    await page.getByRole("button", { name: "Save RSVPs" }).click();

    await expect(page.getByText("RSVPs saved.")).toBeVisible();
    await expect(page.getByText(/changed somewhere else/i)).toHaveCount(0);
});
