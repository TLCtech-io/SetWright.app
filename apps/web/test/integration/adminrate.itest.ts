// Track 2 phase A: the platform-admin flag guard and the invite rate limiter.
//   - is_platform_admin cannot be self-set by an authenticated user (column privilege); only the
//     service-role SQL bootstrap can set it. auth_is_platform_admin reflects it.
//   - the deny-all invite_rate_event table leaks nothing; consume_invite_quota enforces the per-actor
//     ceiling; consume_invite_quota_by_email is service-role only and enforces the per-email ceiling.
import { assert, signInAs, serviceClient, sqlAsPostgres } from "./helpers";

export async function run(): Promise<void> {
    const admin = serviceClient();

    // --- platform-admin flag ---------------------------------------------------
    const { client: ben } = await signInAs("ben@example.com");
    const uid = (await ben.auth.getUser()).data.user!.id;

    assert(
        (await ben.rpc("auth_is_platform_admin")).data === false,
        "auth_is_platform_admin is false for a normal user",
    );

    // The self-promotion vector: a user PATCHing is_platform_admin on their OWN row. Blocked by the
    // column privilege (authenticated may update only email/display_name), independent of RLS.
    const promote = await ben
        .from("app_user")
        .update({ is_platform_admin: true })
        .eq("id", uid);
    assert(
        promote.error !== null,
        "a user cannot PATCH is_platform_admin on their own row",
    );
    // The flag really did not move. Read it through the guard's own DEFINER function, not a direct
    // table read (service_role has no grant on app_user; only the definer function or postgres can see it).
    assert(
        (await ben.rpc("auth_is_platform_admin")).data === false,
        "the blocked self-promote left the flag false",
    );

    // A self-edit of an allowed column still works, so the guard narrowed nothing legitimate.
    assert(
        (
            await ben
                .from("app_user")
                .update({ display_name: "Ben Edited" })
                .eq("id", uid)
        ).error === null,
        "a user can still self-edit an allowed column (display_name)",
    );

    // The real bootstrap is a superuser SQL statement (the Supabase SQL editor at cutover), not
    // service_role and not any app route. auth_is_platform_admin then returns true (it reads the live flag).
    sqlAsPostgres(
        `update app_user set is_platform_admin = true where id = '${uid}';`,
    );
    assert(
        (await ben.rpc("auth_is_platform_admin")).data === true,
        "auth_is_platform_admin is true after the SQL bootstrap",
    );

    // --- invite rate limiter ---------------------------------------------------
    // The counter table is deny-all (RLS on, no grants/policies): it leaks no rows to an authenticated user.
    const rl = await ben.from("invite_rate_event").select("*").limit(1);
    assert(
        (rl.data?.length ?? 0) === 0,
        "invite_rate_event leaks no rows to an authenticated user",
    );

    // The ceiling is server-defined per kind; a client passes only the kind, so it cannot widen or reset
    // its own bucket. A known kind is allowed under its ceiling; an unknown kind fails closed.
    assert(
        (await ben.rpc("consume_invite_quota", { p_kind: "member_invite" }))
            .data === true,
        "consume_invite_quota allows a member_invite under the server ceiling",
    );
    assert(
        (await ben.rpc("consume_invite_quota", { p_kind: "bogus_kind" }))
            .data === false,
        "consume_invite_quota fails closed on an unknown kind",
    );

    // Enforcement: the resend ceiling (3/hour) denies the 4th send, proving the shared engine enforces
    // the server-defined limit. Uses the service-role email variant (the resend path).
    const email = "victim@example.com";
    const sends: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
        sends.push(
            (
                await admin.rpc("consume_invite_quota_by_email", {
                    p_email: email,
                    p_kind: "resend",
                })
            ).data as boolean,
        );
    }
    assert(
        sends.slice(0, 3).every((r) => r === true),
        "consume_invite_quota_by_email allows up to the resend ceiling (3)",
    );
    assert(
        sends[3] === false,
        "consume_invite_quota_by_email denies past the resend ceiling",
    );

    // The email variant is service-role only: a normal user cannot call it.
    assert(
        (
            await ben.rpc("consume_invite_quota_by_email", {
                p_email: email,
                p_kind: "resend",
            })
        ).error !== null,
        "consume_invite_quota_by_email is not callable by an authenticated user",
    );

    // --- admin-authorized founding (create_ensemble_seeded requires a granted credit) -----------------
    const { client: rae } = await signInAs("rae@example.com");
    const raeUid = (await rae.auth.getUser()).data.user!.id;

    // No credit: even a director (rae directs Riverside) cannot found another ensemble.
    assert(
        (
            await rae.rpc("create_ensemble_seeded", {
                p_name: "Unauthorized",
                p_display_name: "Rae",
            })
        ).error !== null,
        "create_ensemble_seeded is denied without a founding credit",
    );
    // grant_founding_credit requires a platform admin; a non-admin caller is rejected.
    assert(
        (await rae.rpc("grant_founding_credit", { p_user_id: raeUid }))
            .error !== null,
        "grant_founding_credit is rejected for a non-admin caller",
    );
    // ben is a platform admin (bootstrapped above); he authorizes exactly one founding for rae.
    assert(
        (await ben.rpc("grant_founding_credit", { p_user_id: raeUid }))
            .error === null,
        "a platform admin can grant a founding credit",
    );
    // The grant is idempotent: a second grant while the credit is unspent does NOT stack a second. A
    // re-sent invite returns the same user, so without this an admin re-invite would let the director
    // found two ensembles for free. The re-grant succeeds as a no-op.
    assert(
        (await ben.rpc("grant_founding_credit", { p_user_id: raeUid }))
            .error === null,
        "a re-grant while the credit is unspent is a no-op success",
    );
    // The credit lets rae found one ensemble, then is consumed. The re-grant did NOT stack, so the second
    // attempt is still denied even after two grants.
    assert(
        (
            await rae.rpc("create_ensemble_seeded", {
                p_name: "Authorized",
                p_display_name: "Rae",
            })
        ).error === null,
        "the granted credit lets a user found one ensemble",
    );
    assert(
        (
            await rae.rpc("create_ensemble_seeded", {
                p_name: "One Too Many",
                p_display_name: "Rae",
            })
        ).error !== null,
        "two grants did not stack: a second founding is still denied",
    );

    // --- grant_founding_credit_by_email: the existing-account onramp -----------------------------------
    // An admin authorizes an EXISTING account (a current member starting their own ensemble) BY EMAIL; no
    // invite is sent, the credit lands on their account, and they self-create. Admin-gated + idempotent.
    assert(
        (
            await rae.rpc("grant_founding_credit_by_email", {
                p_email: "ana@example.com",
            })
        ).error !== null,
        "grant_founding_credit_by_email is rejected for a non-admin caller",
    );
    assert(
        (
            await ben.rpc("grant_founding_credit_by_email", {
                p_email: "nobody@example.com",
            })
        ).data === false,
        "grant_founding_credit_by_email returns false for an unknown email",
    );
    assert(
        (
            await ben.rpc("grant_founding_credit_by_email", {
                p_email: "ana@example.com",
            })
        ).data === true,
        "a platform admin authorizes an existing account by email",
    );
    // The by-email grant lets that existing account found an ensemble.
    const { client: ana } = await signInAs("ana@example.com");
    assert(
        (
            await ana.rpc("create_ensemble_seeded", {
                p_name: "Ana Founds",
                p_display_name: "Ana",
            })
        ).error === null,
        "the by-email grant lets the existing account found an ensemble",
    );

    // Email-change robustness: grant_founding_credit_by_email resolves identity against auth.users
    // (canonical), not the app_user email mirror. Change ana's auth email so the mirror lags; the grant
    // must still find her by the NEW address (the old app_user-mirror lookup would return false here).
    sqlAsPostgres(
        `update auth.users set email = 'ana-renamed@example.com' where id = '00000000-0000-0000-0000-0000000000a1';`,
    );
    assert(
        (
            await ben.rpc("grant_founding_credit_by_email", {
                p_email: "ana-renamed@example.com",
            })
        ).data === true,
        "grant_founding_credit_by_email resolves via auth.users after an email change (stale app_user mirror)",
    );
}
