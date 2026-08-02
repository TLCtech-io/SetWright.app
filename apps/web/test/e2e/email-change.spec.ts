// E2E for the self-service email change (Track 2 follow-up). Exercises the whole front half:
// the profile form calls updateUser({ email }), GoTrue sends confirmation links (both the old and
// the new address, since double_confirm_changes is on), the /auth/confirm route verifies each
// token_hash under type=email_change and lands the member back on their profile, and a re-login with
// the new address proves the change actually applied. The DB mirror (on_auth_user_updated) is
// covered separately by the member integration domain.
//
// Signs in as rae@example.com (director of Riverside Singers), who is used by no other e2e spec, so
// flipping her email cannot strand another test that signs in by the old address. GoTrue's
// email_sent limit is 2/hour and one double-confirm change sends exactly 2, so this needs a fresh
// stack (CI starts one; locally, `supabase db reset` or a restart clears the counter).

import {
    expect,
    test,
    type APIRequestContext,
    type Page,
} from "@playwright/test";

const MAILPIT = "http://127.0.0.1:54324";
const TOKEN = /\/e\/([A-Za-z0-9_-]{22})\//;

async function signIn(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "password123");
    await page.click('button[type="submit"]');
    // Wait for the ENSEMBLE landing, not just for leaving /login: a director's sign-in redirects
    // /login -> / -> /e/{token}/dashboard, and asserting only "not /login" races the second hop (the URL
    // is briefly / before the redirect completes). rae is a director, so she always lands in an ensemble.
    await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{22}\//, {
        timeout: 15_000,
    });
}

// Poll Mailpit for the newest message addressed to `to`, then pull the /auth/confirm token_hash out
// of its body. GoTrue builds the link against site_url (:3000); the caller rebuilds it against the
// test server's baseURL, so only the token matters here.
async function confirmTokenFor(
    api: APIRequestContext,
    to: string,
): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const list = await (
            await api.get(`${MAILPIT}/api/v1/messages?limit=50`)
        ).json();
        const hit = (list.messages ?? []).find(
            (m: { To?: Array<{ Address?: string }> }) =>
                (m.To ?? []).some(
                    (t) => t.Address?.toLowerCase() === to.toLowerCase(),
                ),
        );
        if (hit) {
            const msg = await (
                await api.get(`${MAILPIT}/api/v1/message/${hit.ID}`)
            ).json();
            const body: string = `${msg.HTML ?? ""}${msg.Text ?? ""}`;
            const match =
                /\/auth\/confirm\?token_hash=([^&"'\s<]+)&(?:amp;)?type=email_change/.exec(
                    body,
                );
            if (match) return match[1]!;
            throw new Error(`email to ${to} had no email_change confirm link`);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no email delivered to ${to} within 10s`);
}

test("a member changes their email, confirms both links, and signs in with the new address", async ({
    page,
}) => {
    const oldEmail = "rae@example.com";
    const newEmail = "rae.new@example.com";

    await signIn(page, oldEmail);
    const token = page.url().match(TOKEN)?.[1];
    expect(token, "signed in and landed inside an ensemble").toBeTruthy();

    await page.goto(`/e/${token}/me/profile`);
    await expect(page.getByText("Current email")).toBeVisible();
    await page.getByLabel("New email", { exact: true }).fill(newEmail);
    await page.getByRole("button", { name: "Change email" }).click();

    // The form acknowledges the send without claiming the change is done yet.
    await expect(page.getByText(/Check your inbox/i)).toBeVisible();

    // double_confirm_changes: a link goes to both the current and the new address, and both must be
    // confirmed. Verify each token_hash under type=email_change. The exact landing varies (GoTrue
    // returns no session on the first-of-two confirmation, so the route can't resolve a profile token
    // for it), but neither must ever hit the auth-error page — that would mean the token failed to
    // verify.
    const currentToken = await confirmTokenFor(page.request, oldEmail);
    const nextToken = await confirmTokenFor(page.request, newEmail);
    for (const t of [currentToken, nextToken]) {
        await page.goto(`/auth/confirm?token_hash=${t}&type=email_change`);
        await expect(page).not.toHaveURL(/auth-error/);
    }

    // The change is applied: a fresh sign-in with the NEW address reaches the app, and the account
    // menu shows the new email (server-rendered from the session).
    await page.context().clearCookies();
    await signIn(page, newEmail);
    await page.click("button.nav-avatar");
    await expect(page.getByText(newEmail)).toBeVisible();
});
