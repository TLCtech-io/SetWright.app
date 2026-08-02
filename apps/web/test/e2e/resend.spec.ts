// E2E for the self-serve invite-resend surfaces (phase F). The auth-error and no-access pages both carry
// the resend form, which posts to the unauthenticated, enumeration-safe /api/auth/resend and always shows
// one fixed message. No login needed — these are recovery pages for a stranded / expired-link visitor.

import { expect, test } from "@playwright/test";
import { mailpitCountTo } from "./support";

test("the auth-error page offers a self-serve resend and shows a fixed message", async ({
    page,
}) => {
    await page.goto("/auth/auth-error");
    await expect(
        page.getByRole("heading", { name: /didn.t work/i }),
    ).toBeVisible();
    await page.getByLabel("Your email").fill("someone@example.com");
    await page.getByRole("button", { name: /resend my invitation/i }).click();
    // Enumeration-safe: the same reassurance regardless of whether that address has a pending invite (this
    // one does not, so no email is sent, but the message is identical).
    await expect(page.getByText(/pending invitation/i)).toBeVisible({
        timeout: 15_000,
    });
});

test("resend to a pending-seat address actually sends a fresh link (via after())", async ({
    page,
}) => {
    test.slow(); // the email is sent after the response, so poll for it
    // ana@example.com is the seeded pending seat "Dane" in an active ensemble, so a resend must send. (Use
    // Dane, not Cleo/rae@example.com, so this does not add mail to an address the email-change spec drives.)
    // Count before, resend, then poll until Mailpit shows one more (the send runs post-response via after()).
    const before = await mailpitCountTo("ana@example.com");
    await page.goto("/auth/auth-error");
    await page.getByLabel("Your email").fill("ana@example.com");
    await page.getByRole("button", { name: /resend my invitation/i }).click();
    await expect(page.getByText(/pending invitation/i)).toBeVisible({
        timeout: 15_000,
    });
    await expect
        .poll(async () => await mailpitCountTo("ana@example.com"), {
            timeout: 15_000,
        })
        .toBeGreaterThan(before);
});

test("the no-access page carries the resend form and a sign-out", async ({
    page,
}) => {
    await page.goto("/auth/no-access");
    await expect(
        page.getByRole("heading", { name: /don.t have access/i }),
    ).toBeVisible();
    await expect(page.getByLabel("Your email")).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
});
