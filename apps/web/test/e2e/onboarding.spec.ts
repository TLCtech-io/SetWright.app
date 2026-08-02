// E2E for the onboarding empty states: a brand-new ensemble renders the setup rail and actionable
// empty cards, not a wall of zeros. Signs in as mia@example.com, whose only seeded ensemble is
// archived (so listMyEnsembles hides it and she reads as a fresh director), then creates her first
// ensemble through the real create -> create_ensemble_seeded flow. A freshly seeded ensemble has
// only the director, so it IS the onboarding state. Runs in supabase mode against the local seed.
//
// mia is used by no other e2e spec, so creating ensembles here cannot shift another test's active
// ensemble (getActiveEnsembleId falls back to an unordered mine[0]). Each run mints one ensemble
// under mia; the founding-quota (20 owned) resets on a fresh stack (CI) or `supabase db reset`.

import { expect, test, type Page } from "@playwright/test";

const TOKEN = /\/e\/([A-Za-z0-9_-]{22})\//;

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    // mia has no active ensemble, so the home resolver sends her to the manage hub, not a dashboard.
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

test("a fresh director creates a first ensemble and sees the onboarding empty states", async ({
    page,
}) => {
    await signIn(page, "mia@example.com");

    // Create the first ensemble; it starts empty, which is exactly the onboarding state. Name carries
    // a timestamp so repeated local runs (before a db reset) do not collide on the per-name checks.
    const name = `Onboarding Test ${Date.now()}`;
    await page.goto("/ensembles");
    await page.getByLabel("New ensemble name").fill(name);
    await page.getByRole("button", { name: "Create ensemble" }).click();
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\/dashboard/, {
        timeout: 15_000,
    });
    const token = page.url().match(TOKEN)![1]!;

    // Dashboard: the three-step setup rail stands in for the "Next event" hero, and the "all caught
    // up" reassurance is suppressed while the book is empty.
    await expect(page.getByText(name)).toBeVisible();
    // exact: true targets the step-title spans, not the intro sentence that also names all three steps.
    await expect(page.getByText("Add singers", { exact: true })).toBeVisible();
    await expect(
        page.getByText("Build your book", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText("Create an event", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("link", { name: /Add your first song/ }),
    ).toBeVisible();
    await expect(page.getByText(/all caught up/)).toHaveCount(0);

    // Repertoire: no search/sort toolbar over an empty book; a real "add" link inside the empty card.
    await page.goto(`/e/${token}/repertoire`);
    await expect(page.getByText(/Your book is empty/)).toBeVisible();
    await expect(
        page.getByRole("link", { name: /Add your first song/ }),
    ).toBeVisible();
    await expect(page.locator("input.songs-search")).toHaveCount(0);

    // Events: a clickable CTA per empty tab, toolbar suppressed; the Rehearsals tab has its own copy.
    await page.goto(`/e/${token}/events`);
    await expect(page.getByText(/No gigs on the calendar yet/)).toBeVisible();
    await expect(
        page.getByRole("link", { name: /Create your first event/ }),
    ).toBeVisible();
    await expect(page.locator("input.songs-search")).toHaveCount(0);
    await page.getByRole("tab", { name: /Rehearsals/ }).click();
    await expect(
        page.getByText(/No rehearsals on the calendar yet/),
    ).toBeVisible();
    await expect(
        page.getByRole("link", { name: /Create your first rehearsal/ }),
    ).toBeVisible();

    // Insights: the no-data intro line, and stat cards read a dim em-dash, not a green-looking zero.
    await page.goto(`/e/${token}/insights`);
    await expect(
        page.getByText(/These reports fill in as you build your book/),
    ).toBeVisible();
    await expect(page.locator(".card-stat.none").first()).toBeVisible();

    // Member home: a fresh director has no next event and nothing cast, so the welcome orientation
    // shows with the "set your range" nudge.
    await page.goto(`/e/${token}/me`);
    await expect(
        page.getByText(/Your director sets your parts and schedule/),
    ).toBeVisible();
    await expect(
        page.getByRole("link", { name: /Set your range/ }),
    ).toBeVisible();

    // Member songs: empty-book copy, toolbar suppressed (mirrors the director repertoire fix).
    await page.goto(`/e/${token}/me/songs`);
    await expect(page.getByText(/The book is empty for now/)).toBeVisible();
    await expect(page.locator("input.songs-search")).toHaveCount(0);
});
