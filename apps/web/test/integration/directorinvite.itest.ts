// Track 2 phase C: the director-invite on-ramp at the data layer.
//   - sendDirectorInvite stamps the confirm-route metadata (display_name + pending_ensemble_name) onto a
//     new invited account and returns its id.
//   - without a granted credit that account still cannot found an ensemble (the 057 gate holds for the
//     invited director too), and once a credit is granted it seeds exactly what the confirm route does.
// The email delivery + verifyOtp glue is covered by the invite-click e2e; this proves the data path.
import { createClient } from "@supabase/supabase-js";
import { assert, signInAs, sqlAsPostgres, supaEnv } from "./helpers";

export async function run(): Promise<void> {
    // sendDirectorInvite reaches lib/env + adminClient, which read process.env at module load (eagerly, in
    // supabase mode). The integration runner does not set those, so set them from the live stack and then
    // DYNAMIC-import the helper, so it resolves against the running stack rather than mock mode.
    const { url, anon, service } = supaEnv();
    process.env.DATA_SOURCE = "supabase";
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
    process.env.SUPABASE_SERVICE_ROLE_KEY = service;
    const { sendDirectorInvite } = await import("../../lib/invite");

    const admin = createClient(url, service, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = "invited-director@example.com";

    // 1. The helper invites the director and returns the new user's id.
    const res = await sendDirectorInvite(email, {
        displayName: "Dana",
        ensembleName: "Invited Choir",
    });
    assert(
        res.delivered && !!res.userId,
        "sendDirectorInvite delivers and returns the new user id",
    );
    const userId = res.userId!;

    // A re-invite of the same unaccepted address returns the SAME user (GoTrue resends rather than
    // erroring), which is why grant_founding_credit must be idempotent: the invite route would otherwise
    // grant twice on a re-send and let the director found two ensembles for free.
    const again = await sendDirectorInvite(email, {
        displayName: "Dana",
        ensembleName: "Invited Choir",
    });
    assert(
        again.delivered && again.userId === userId,
        "a re-invite of the same unaccepted email returns the same user",
    );

    // 2. The metadata the confirm route reads is stamped on the account.
    const { data: got } = await admin.auth.admin.getUserById(userId);
    const md = (got.user?.user_metadata ?? {}) as {
        pending_ensemble_name?: string;
        display_name?: string;
    };
    assert(
        md.pending_ensemble_name === "Invited Choir",
        "the invite stamps pending_ensemble_name for the seed",
    );
    assert(
        md.display_name === "Dana",
        "the invite stamps display_name for the director row",
    );

    // Make the invited account usable (set a password + confirm) and sign in as the invited director, the
    // way accepting the emailed invite would leave them.
    await admin.auth.admin.updateUserById(userId, {
        password: "password123",
        email_confirm: true,
    });
    const { client: dir } = await signInAs(email);

    // 3. No credit yet: the invited director cannot found an ensemble (057 gate). The admin must authorize it.
    assert(
        (
            await dir.rpc("create_ensemble_seeded", {
                p_name: "Invited Choir",
                p_display_name: "Dana",
            })
        ).error !== null,
        "the invited director cannot seed without a granted founding credit",
    );

    // 4. The admin grants the credit (a platform admin's authenticated session; here via a superuser UPDATE
    //    standing in for the grant_founding_credit the admin route will make). The seed then succeeds,
    //    consumes the credit, and lands the director in a real, seeded ensemble they direct.
    sqlAsPostgres(
        `update app_user set founding_credits = founding_credits + 1 where id = '${userId}';`,
    );
    const seeded = await dir.rpc("create_ensemble_seeded", {
        p_name: "Invited Choir",
        p_display_name: "Dana",
    });
    assert(
        !seeded.error && typeof seeded.data === "string",
        "the granted credit lets the invited director seed",
    );
    const ensId = seeded.data as string;
    const me = (
        await dir
            .from("member")
            .select("permission_tier, status")
            .eq("ensemble_id", ensId)
            .eq("user_id", userId)
            .single()
    ).data as { permission_tier: string; status: string };
    assert(
        me.permission_tier === "director" && me.status === "active",
        "the invited director owns the seeded ensemble",
    );

    // The credit is single-use: a second founding is denied.
    assert(
        (
            await dir.rpc("create_ensemble_seeded", {
                p_name: "One Too Many",
                p_display_name: "Dana",
            })
        ).error !== null,
        "the granted credit is consumed: a second founding is denied",
    );
}
