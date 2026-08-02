// Access hardening. Archived-ensemble denial: an archived ensemble denies its members all content
// (auth_member_tier resolves only for an active ensemble). Sole-director protection: the database
// itself refuses to demote/deactivate the sole active director, regardless of entry path.
import { createSupabaseRepository } from "../../lib/supabase/repository";
import { assert, signInAs } from "./helpers";

const ANA_UID = "00000000-0000-0000-0000-0000000000a1";
const MIA_UID = "00000000-0000-0000-0000-0000000000d4";

export async function run(): Promise<void> {
    // --- Archived-ensemble denial (Mia directs the seeded "Retired Choir") -----
    const { client: mia } = await signInAs("mia@example.com");
    const ensC = (
        await mia
            .from("member")
            .select("ensemble_id, permission_tier")
            .eq("user_id", MIA_UID)
            .single()
    ).data as { ensemble_id: string; permission_tier: string };
    assert(
        ensC.permission_tier === "director",
        "Mia is the (self-readable) director of the archived ensemble",
    );
    const repoC = createSupabaseRepository(mia, ensC.ensemble_id);
    // The ensemble has a seeded song, but archived -> auth_member_tier null -> no content visible.
    // (Mia still sees her OWN member row via the member_read self-branch, which is correct; the
    // gate is on shared content — songs, and the ensemble row itself.)
    assert(
        (await repoC.listSongs()).length === 0,
        "an archived ensemble exposes no songs even to its own director",
    );
    assert(
        (
            await mia
                .from("ensemble")
                .select("id")
                .eq("id", ensC.ensemble_id)
                .maybeSingle()
        ).data === null,
        "the archived ensemble row is not readable",
    );

    // --- The DB refuses to orphan an ensemble of its sole director ------
    const { client: ana } = await signInAs("ana@example.com");
    const anaSeat = (
        (await ana.from("member").select("id").eq("user_id", ANA_UID).single())
            .data as { id: string }
    ).id;
    const demote = await ana
        .from("member")
        .update({ permission_tier: "member" })
        .eq("id", anaSeat);
    assert(
        demote.error !== null,
        "a direct write cannot demote the sole active director",
    );
    const deactivate = await ana
        .from("member")
        .update({ status: "inactive" })
        .eq("id", anaSeat);
    assert(
        deactivate.error !== null,
        "a direct write cannot deactivate the sole active director",
    );
    const still = (
        await ana
            .from("member")
            .select("permission_tier, status")
            .eq("id", anaSeat)
            .single()
    ).data as { permission_tier: string; status: string };
    assert(
        still.permission_tier === "director" && still.status === "active",
        "the sole director is unchanged after the blocked writes",
    );

    // Nulling the sole director's user_id is the same orphan as a demote — the trigger now
    // watches user_id too (it kept tier+status the same, so the old guard let it through).
    const orphan = await ana
        .from("member")
        .update({ user_id: null })
        .eq("id", anaSeat);
    assert(
        orphan.error !== null,
        "a direct write cannot null the sole active director's user_id",
    );
    const bound = (
        await ana.from("member").select("user_id").eq("id", anaSeat).single()
    ).data as { user_id: string | null };
    assert(
        bound.user_id === ANA_UID,
        "the sole director stays bound to their user after the blocked write",
    );

    // --- Archived ensembles freeze SELF writes too, not just shared data -------
    const miaSeat = (
        await mia
            .from("member")
            .select("id, display_name")
            .eq("user_id", MIA_UID)
            .single()
    ).data as { id: string; display_name: string };
    // update_my_profile is SECURITY DEFINER, but its WHERE now requires an active ensemble, so for an
    // archived tenant it matches nothing: the call runs without error but changes nothing.
    const reprofile = await mia.rpc("update_my_profile", {
        p_member: miaSeat.id,
        p_display_name: "Renamed In Archive",
        p_range_low: null,
        p_range_high: null,
    });
    assert(
        reprofile.error === null,
        "update_my_profile runs (no error) even in an archived ensemble",
    );
    const profileAfter = (
        await mia
            .from("member")
            .select("display_name")
            .eq("id", miaSeat.id)
            .single()
    ).data as { display_name: string };
    assert(
        profileAfter.display_name === miaSeat.display_name,
        "but an archived ensemble member cannot actually change their profile (no-op)",
    );

    // The legacy create_ensemble RPC (the vocabulary-less founder) is dropped and must stay dropped —
    // only create_ensemble_seeded survives.
    const resurrected = await ana.rpc("create_ensemble", {
        p_name: "Should Not Exist",
        p_display_name: "Ana",
    });
    assert(
        resurrected.error !== null,
        "create_ensemble is dropped (not callable)",
    );

    // guard_last_director blocks moving the sole director's seat to
    // another ensemble — Mia's archived ensemble is a separate tenant, so a re-parent would orphan A.
    const ensC2 = (
        await mia
            .from("member")
            .select("ensemble_id")
            .eq("user_id", MIA_UID)
            .single()
    ).data as { ensemble_id: string };
    const reparent = await ana
        .from("member")
        .update({ ensemble_id: ensC2.ensemble_id })
        .eq("id", anaSeat);
    assert(
        reparent.error !== null,
        "the sole director seat cannot be re-parented to another ensemble",
    );
}
