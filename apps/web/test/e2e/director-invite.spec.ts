// E2E for the director-invite acceptance path (phase C's confirm-route seed). An admin invites a new
// director carrying a pending ensemble name; the invited user clicks the emailed link; /auth/confirm
// verifies the one-time token, seeds their ensemble (consuming the founding credit the admin granted),
// and — because an invite has no password yet — lands them on /auth/welcome to set one. This exercises
// the real flow end to end, including the emailed token read back from Mailpit. Setup uses the admin API
// directly (the admin UI lands in a later phase) and grants the credit as the seeded platform admin
// (sam) through their own session, exactly as the admin route will.

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { API_URL, ANON, SERVICE, inviteTokenHash } from "./support";

test("an admin-invited director confirms, seeds their ensemble, and lands on welcome", async ({
    page,
}) => {
    test.slow(); // sends + polls for a real email, then a cold confirm render
    const admin = createClient(API_URL, SERVICE, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `invited-${Date.now()}@example.com`;

    // 1. Admin invites the new director with the pending ensemble name (what sendDirectorInvite does).
    const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(
        email,
        {
            data: {
                display_name: "Dana",
                pending_ensemble_name: "Invited Choir",
            },
        },
    );
    expect(error, error?.message ?? undefined).toBeFalsy();
    const userId = invited!.user!.id;

    // 2. Grant the founding credit as the platform admin (sam), through their own authenticated session —
    //    exactly what the admin route will do (grant_founding_credit checks the caller is a platform admin).
    const sam = createClient(API_URL, ANON, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    await sam.auth.signInWithPassword({
        email: "sam@example.com",
        password: "password123",
    });
    const grant = await sam.rpc("grant_founding_credit", { p_user_id: userId });
    expect(grant.error, grant.error?.message ?? undefined).toBeFalsy();

    // 3. The invited director clicks the emailed link. The email points at SiteURL; we only need its
    //    one-time token_hash, then verify it on the test server so the email's port never matters.
    const tokenHash = await inviteTokenHash(email);
    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=invite`);

    // 4. The confirm route seeded the ensemble (consuming the credit) and, because an invite has no password
    //    yet, routed them to /auth/welcome carrying their new ensemble's token. The ?e token only exists if
    //    create_ensemble_seeded actually ran — so this asserts the seed, not just the redirect.
    await expect(page).toHaveURL(/\/auth\/welcome\?e=[A-Za-z0-9_-]{22}/, {
        timeout: 15_000,
    });
});
