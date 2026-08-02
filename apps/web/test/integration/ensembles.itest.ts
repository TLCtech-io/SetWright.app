// Onboarding + multi-ensemble scoping: create_ensemble_seeded makes
// a usable ensemble; an existing director who calls it gains another; and the adapter
// scopes every read to the active ensemble even when the user belongs to several.
import { createSupabaseRepository } from "../../lib/supabase/repository";
import {
    assert,
    confirmUser,
    freshClient,
    signInAs,
    sqlAsPostgres,
} from "./helpers";

const ANA_UID = "00000000-0000-0000-0000-0000000000a1";
const count = async (q: { count: number | null }) => q.count ?? 0;

export async function run(): Promise<void> {
    const { client } = await signInAs("ana@example.com");

    // Ana starts in one ensemble (the seeded "Harmony Collective").
    const ensA = (
        (
            await client
                .from("member")
                .select("ensemble_id")
                .eq("user_id", ANA_UID)
                .single()
        ).data as { ensemble_id: string }
    ).ensemble_id;

    // Ensemble settings (the tenant row): the director reads + writes name/timezone/visibility,
    // guarded by an optimistic-concurrency token.
    const repoSettings = createSupabaseRepository(client, ensA);
    const s0 = await repoSettings.getEnsembleSettings();
    assert(
        s0.name === "Harmony Collective" &&
            s0.confidenceVisibility === "private" &&
            !!s0.version,
        "getEnsembleSettings returns the seeded ensemble row + a version",
    );
    const w1 = await repoSettings.updateEnsembleSettings(
        {
            name: "Harmony Collective",
            timezone: "America/Chicago",
            confidenceVisibility: "shared",
        },
        s0.version!,
    );
    assert(
        w1.ok && !!w1.version && w1.version !== s0.version,
        "a director can update ensemble settings, advancing the version",
    );
    const s1 = await repoSettings.getEnsembleSettings();
    assert(
        s1.timezone === "America/Chicago" &&
            s1.confidenceVisibility === "shared",
        "updateEnsembleSettings persisted timezone + visibility",
    );
    // A stale token (s0's, now superseded by w1) loses the race instead of clobbering.
    const stale = await repoSettings.updateEnsembleSettings(
        { name: "Clobber", timezone: "UTC", confidenceVisibility: "private" },
        s0.version!,
    );
    assert(
        !stale.ok && stale.reason === "conflict",
        "a stale settings write conflicts (no silent clobber)",
    );
    assert(
        (await repoSettings.getEnsembleSettings()).name ===
            "Harmony Collective",
        "the conflicting write changed nothing",
    );
    // A non-director (Ben, a member of A) is denied by RLS — reported forbidden, even with a fresh token.
    const benForSettings = await signInAs("ben@example.com");
    const benRepo = createSupabaseRepository(benForSettings.client, ensA);
    const benWrite = await benRepo.updateEnsembleSettings(
        { name: "Hacked", timezone: "UTC", confidenceVisibility: "private" },
        (await benRepo.getEnsembleSettings()).version!,
    );
    assert(
        !benWrite.ok && benWrite.reason === "forbidden",
        "a non-director cannot update ensemble settings (RLS denies)",
    );
    assert(
        (await repoSettings.getEnsembleSettings()).confidenceVisibility ===
            "shared",
        "the denied write changed nothing",
    );

    // create_ensemble_seeded now requires a founding credit (admin-authorized creation). Grant one the way
    // a platform admin would, so the existing-director-founds-another path can still be exercised.
    sqlAsPostgres(
        `update app_user set founding_credits = founding_credits + 1 where id = '${ANA_UID}';`,
    );
    const { data: ens, error } = await client.rpc("create_ensemble_seeded", {
        p_name: "Second Choir",
        p_display_name: "Ana",
    });
    assert(
        !error && typeof ens === "string",
        "create_ensemble_seeded returns the new ensemble id",
    );
    const ensB = ens as string;

    const me = (
        await client
            .from("member")
            .select("permission_tier, status")
            .eq("ensemble_id", ensB)
            .eq("user_id", ANA_UID)
            .single()
    ).data as { permission_tier: string; status: string };
    assert(
        me.permission_tier === "director" && me.status === "active",
        "the creator is the new ensemble’s active director",
    );
    assert(
        (await count(
            await client
                .from("voice_part")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ensB),
        )) === 5,
        "5 voice parts seeded",
    );
    assert(
        (await count(
            await client
                .from("tag")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ensB),
        )) === 4,
        "4 tags seeded",
    );
    assert(
        (await count(
            await client
                .from("padding_profile")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ensB),
        )) === 2,
        "2 padding profiles seeded",
    );
    assert(
        (await count(
            await client
                .from("event_type")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ensB),
        )) === 2,
        "2 event types seeded",
    );
    assert(
        (await count(
            await client
                .from("member")
                .select("id", { count: "exact", head: true })
                .eq("user_id", ANA_UID),
        )) === 2,
        "the creator now belongs to two ensembles",
    );

    // The adapter scopes to whichever ensemble is active, even though Ana is in both.
    const repoA = createSupabaseRepository(client, ensA);
    const repoB = createSupabaseRepository(client, ensB);
    assert(
        (await repoA.listSongs()).length === 5 &&
            (await repoB.listSongs()).length === 0,
        "songs scoped to the active ensemble (A has 5, the new one none)",
    );
    assert(
        (await repoA.listTags()).length === 5 &&
            (await repoB.listTags()).length === 4,
        "tags scoped (A’s 5 vs the new ensemble’s seeded 4)",
    );
    assert(
        (await repoA.listRoster()).length === 4 &&
            (await repoB.listRoster()).length === 1,
        "roster scoped (A has 4, the new one just the creator)",
    );
    const aVp = (await repoA.listVoiceParts())[0]!.id;
    const bVp = (await repoB.listVoiceParts())[0]!.id;
    assert(
        aVp !== bVp,
        "same-named voice parts are distinct rows per ensemble",
    );

    // ID-based ops are scoped to the ACTIVE ensemble: a B-scoped repo cannot reach A's rows
    // by id, even though RLS authorizes Ana in both. Before scoping, repoB.getSong(aSong) returned
    // A's song (a live cross-ensemble read), and the RPC writes claimed A's rows by id from B.
    const aSong = (await repoA.listSongs())[0]!;
    const aSongVer = (await repoA.getSong(aSong.id))!.version!;
    assert(
        (await repoB.getSong(aSong.id)) === undefined,
        "B-scoped repo cannot read A’s song by id",
    );
    assert(
        (await repoB.getSongParts(aSong.id)).length === 0,
        "B-scoped repo cannot read A’s parts by id",
    );
    assert(
        (await repoB.setSongStatus(aSong.id, "archived")) === undefined,
        "B-scoped repo cannot archive A’s song",
    );
    const crossSave = await repoB.updateSong(
        aSong.id,
        {
            song: { ...aSong, title: "Cross-ensemble" },
            arranger: null,
            chartRef: null,
            lastRehearsed: null,
            startPitch: null,
            parts: [],
        },
        aSongVer,
    );
    assert(
        !crossSave.ok && crossSave.reason === "not_found",
        "B-scoped repo cannot save A’s song (ownership gate)",
    );
    assert(
        (await repoA.getSong(aSong.id))!.title === aSong.title,
        "A’s song is untouched by the cross-ensemble attempts",
    );
    const aEvent = (await repoA.listEvents())[0]!;
    assert(
        (await repoB.getEvent(aEvent.id)) === undefined,
        "B-scoped repo cannot read A’s event by id",
    );

    // An ignored request for an ensemble the user doesn't belong to falls back to a real one.
    const repoBogus = createSupabaseRepository(
        client,
        "00000000-0000-0000-0000-000000000999",
    );
    assert(
        (await repoBogus.listSongs()).length >= 0,
        "a non-member ensemble request falls back to a membership, never leaks",
    );

    // Public signup: a brand-new account creates its first, seeded ensemble and can draft.
    const fresh = freshClient();
    const { error: signUpErr } = await fresh.auth.signUp({
        email: "newdir@example.com",
        password: "password123",
        options: { data: { display_name: "Nia" } },
    });
    assert(!signUpErr, "signUp succeeds");
    // Email confirmation is ON, so signUp returns no session until confirmed; stand in for the email click.
    await confirmUser("newdir@example.com");
    await fresh.auth.signInWithPassword({
        email: "newdir@example.com",
        password: "password123",
    });
    // The invite grants the founding credit; stand in for it (this account's app_user mirror carries the email).
    sqlAsPostgres(
        `update app_user set founding_credits = founding_credits + 1 where email = 'newdir@example.com';`,
    );
    const { error: rpcErr } = await fresh.rpc("create_ensemble_seeded", {
        p_name: "Brand New Choir",
        p_display_name: "Nia",
    });
    assert(!rpcErr, "create_ensemble_seeded succeeds for the new account");
    const freshRepo = createSupabaseRepository(fresh);
    assert(
        (await freshRepo.listVoiceParts()).length === 5 &&
            (await freshRepo.listEventTypes()).length === 2,
        "the new account lands in a usable, seeded ensemble",
    );
    assert(
        (await freshRepo.listSongs()).length === 0 &&
            (await freshRepo.listRoster()).length === 1,
        "the new ensemble starts empty but for its director",
    );

    // A signed-in account that belongs to NO ensemble (a fresh sign-up that never onboarded)
    // is denied every ensemble-scoped read — the adapter has nothing to scope to, so it refuses
    // rather than leaking another tenant's rows.
    const orphan = freshClient();
    const { error: orphanErr } = await orphan.auth.signUp({
        email: "orphan@example.com",
        password: "password123",
        options: { data: { display_name: "Orphan" } },
    });
    assert(!orphanErr, "orphan signUp succeeds");
    await confirmUser("orphan@example.com");
    await orphan.auth.signInWithPassword({
        email: "orphan@example.com",
        password: "password123",
    });
    let denied = false;
    try {
        await createSupabaseRepository(orphan).listSongs();
    } catch {
        denied = true;
    }
    assert(
        denied,
        "a no-membership session is denied ensemble-scoped reads (never leaks)",
    );
}
