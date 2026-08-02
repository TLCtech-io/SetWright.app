// E2E for the public-id URL contract: every address-bar URL the app builds carries an opaque
// token (public_id, a 22-char base64url string), never an internal uuid. Inner segments still
// resolve token -> uuid server-side, so a garbage token is a clean not-found, not a 500. Runs
// against a supabase-mode dev server with the local seed (see supabase/seed.sql):
//   ana@example.com  — director of "Harmony Collective" (Ensemble A)
//   ben@example.com  — member of Ensemble A (the non-director viewer)
// Authored to run in CI against a live stack; it needs the seed, so it is not part of the offline gate.

import { expect, test, type Page } from "@playwright/test";

// A uuid anywhere in the string. The whole point of the feature is that this never appears in
// the address bar.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// An ensemble path segment carrying a 22-char base64url token (the public_id shape).
const TOKEN_IN_PATH = /\/e\/[A-Za-z0-9_-]{22}(?:\/|$)/;

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/e\/[^/]+\//);
}

// The ensemble token from the current URL, so member tests can build /e/:token/... paths directly.
function ensembleToken(url: string): string {
    const m = url.match(/\/e\/([A-Za-z0-9_-]{22})/);
    if (!m) throw new Error(`no ensemble token in ${url}`);
    return m[1]!;
}

// Assert the current address bar carries a token and no uuid — the core invariant, checked at every
// hop of a navigation.
function expectCleanUrl(page: Page): void {
    expect(page.url()).not.toMatch(UUID);
    expect(page.url()).toMatch(TOKEN_IN_PATH);
}

test("director navigation never puts a uuid in the address bar", async ({
    page,
}) => {
    await signIn(page, "ana@example.com");
    // The home redirect lands inside the active ensemble on the Dashboard, addressed by token.
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\/dashboard/);
    expectCleanUrl(page);

    // Dashboard -> Repertoire.
    await page
        .locator("nav.nav")
        .getByRole("link", { name: "Repertoire" })
        .click();
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\/repertoire$/);
    expectCleanUrl(page);

    // Repertoire -> a song (the first row's title link).
    await page.locator("a.song-name").first().click();
    await expect(page).toHaveURL(/\/repertoire\/[A-Za-z0-9_-]{22}$/);
    expectCleanUrl(page);

    // Song -> its casting screen (the "Cast this song" action on the edit page).
    await page.getByRole("link", { name: "Cast this song" }).click();
    await expect(page).toHaveURL(/\/repertoire\/[A-Za-z0-9_-]{22}\/casting$/);
    expectCleanUrl(page);

    // Casting -> Events.
    await page.locator("nav.nav").getByRole("link", { name: "Events" }).click();
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\/events$/);
    expectCleanUrl(page);

    // Events -> an event (the first gig row's title link).
    await page.locator("table.hub-table td.cell-title a").first().click();
    await expect(page).toHaveURL(/\/events\/[A-Za-z0-9_-]{22}$/);
    expectCleanUrl(page);
    const eventToken = page.url().split("/events/")[1]!.split(/[/?#]/)[0]!;

    // Event -> its draft. The draft page resolves the event token to a uuid before hydrating; the URL
    // stays a token. (Reached by token URL; the event page's setlists open a setlist, this exercises
    // the by-event draft route directly.)
    await page.goto(`/e/${ensembleToken(page.url())}/draft/${eventToken}`);
    expectCleanUrl(page);
    expect(page.url()).toContain(`/draft/${eventToken}`);
});

test("the print sheet ?order= round-trips with tokens only", async ({
    page,
}) => {
    await signIn(page, "ana@example.com");

    // Open the gig that has a DRAFT set (seed: "Summer concert" -> "Main set" draft; "Winter showcase"
    // is performed and would not carry ?order=). The event page is a stack of CollapsibleSections all
    // collapsed on load, so expand "Setlists" before the "Open" link is actionable.
    await page.locator("nav.nav").getByRole("link", { name: "Events" }).click();
    await page
        .locator("table.hub-table")
        .getByRole("link", { name: "Summer concert" })
        .click();
    await page.getByRole("button", { name: "Setlists" }).click();
    await page
        .locator(".setlist-mgr")
        .getByRole("link", { name: "Open" })
        .first()
        .click();
    await expect(page).toHaveURL(/\/setlist\/[A-Za-z0-9_-]{22}$/);
    expectCleanUrl(page);

    // The "Print running order" link carries the hand order as ?order=<comma-separated tokens>. The
    // setlist token in the path and every id in ?order= must be tokens, never uuids.
    const printLink = page.getByRole("link", { name: "Print running order" });
    const href = await printLink.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href!).not.toMatch(UUID);
    expect(href!).toContain("/sheet?order=");

    await printLink.click();
    await expect(page).toHaveURL(/\/setlist\/[A-Za-z0-9_-]{22}\/sheet/);
    // The full URL, query string included, is uuid-free; the reader resolved the token order back to
    // the set's songs, so the sheet renders rows rather than dropping them all.
    expect(page.url()).not.toMatch(UUID);
    await expect(page.locator("table")).toBeVisible();
});

test("a garbage inner token is a clean not-found, not a 500", async ({
    page,
}) => {
    await signIn(page, "ana@example.com");
    const token = ensembleToken(page.url());

    // A setlist page resolves its token via resolvePublicId and calls notFound() on a miss. The property
    // that matters: a garbage token is a text miss (no uuid cast), so it never 500s. There is no custom
    // not-found boundary, so notFound() renders Next's default and the status is not a guaranteed 404;
    // assert the invariant (no server error) and that no real setlist rendered.
    const res = await page.goto(`/e/${token}/setlist/not-a-real-setlist-tok`);
    expect(res?.status()).toBeLessThan(500);
    await expect(
        page.getByRole("link", { name: "Print running order" }),
    ).toHaveCount(0);

    // A song page with an inline not-found affordance renders it (a normal 200 page) for a bad token,
    // rather than crashing.
    await page.goto(`/e/${token}/repertoire/not-a-real-song-token0`);
    await expect(page.getByText("Song not found")).toBeVisible();
});

test("a member reaches the call sheet by token from their space, with no bounce", async ({
    page,
}) => {
    await signIn(page, "ben@example.com");
    const token = ensembleToken(page.url());

    // From the member's schedule (under /me), the event name opens that event's call sheet, addressed
    // by token. The member is admitted to this shared route (they see the read-only call sheet).
    await page.goto(`/e/${token}/me/schedule`);
    await page.locator("a.sched-name-link").first().click();
    await expect(page).toHaveURL(/\/events\/[A-Za-z0-9_-]{22}$/);
    expectCleanUrl(page);
    // The member call sheet, not a bounce back to /me or /login: its "Your schedule" back-link is the
    // tell (the director console on this route has an "Events" back-link instead).
    await expect(
        page.getByRole("link", { name: "Your schedule" }),
    ).toBeVisible();
});

test("a member is bounced from director-only event routes", async ({
    page,
}) => {
    await signIn(page, "ben@example.com");
    const token = ensembleToken(page.url());

    // The events management list, the new-event form, and the attendance roster are director-only. The
    // proxy bounces a member off each; the member never lands on the requested path.
    for (const path of [`/e/${token}/events`, `/e/${token}/events/new`]) {
        await page.goto(path);
        await expect(page).not.toHaveURL(
            new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
        );
    }

    // The attendance roster is addressed by an event token; reach one from the member's schedule, then
    // try its /roster child and confirm the bounce.
    await page.goto(`/e/${token}/me/schedule`);
    await page.locator("a.sched-name-link").first().click();
    await expect(page).toHaveURL(/\/events\/[A-Za-z0-9_-]{22}$/);
    const eventToken = page.url().split("/events/")[1]!.split(/[/?#]/)[0]!;
    await page.goto(`/e/${token}/events/${eventToken}/roster`);
    await expect(page).not.toHaveURL(/\/roster$/);
});
