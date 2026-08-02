// Casting confidence column ownership: the member owns self_reported_confidence;
// a director cannot overwrite it, however they write the row.
import { assert, signInAs } from "./helpers";

const BEN_UID = "00000000-0000-0000-0000-0000000000b2";

export async function run(): Promise<void> {
    const { repo, client } = await signInAs("ana@example.com");
    const grave = (await repo.listSongs()).find((s) =>
        s.title.startsWith("Ain't No Grave"),
    )!;
    const lead = (await repo.getSongCasting(grave.id)).find(
        (c) => c.isPrimary,
    )!; // Cleo, shaky
    assert(lead.confidence === "shaky", "seed: grave lead self-reported shaky");

    // A director's DIRECT update to the column is reverted by the trigger.
    const leadPart = (await repo.getSongParts(grave.id)).find((p) => p.isSolo)!;
    const row = (
        await client
            .from("casting")
            .select("id")
            .eq("part_id", leadPart.id)
            .eq("is_primary", true)
            .single()
    ).data as { id: string };
    await client
        .from("casting")
        .update({ self_reported_confidence: "solid" })
        .eq("id", row.id);
    assert(
        (await repo.getSongCasting(grave.id)).find((c) => c.isPrimary)!
            .confidence === "shaky",
        "a director cannot overwrite a member self-report (trigger reverts)",
    );

    // The director's setSongCasting re-save preserves the prior self-report, not the payload.
    const cast = await repo.getSongCasting(grave.id);
    const graveVer = (await repo.getSong(grave.id))!.version!;
    await repo.setSongCasting(
        grave.id,
        cast.map((c) => ({
            partId: c.partId,
            memberId: c.memberId,
            isPrimary: c.isPrimary,
            confidence: "learning",
            directorAssessed: c.directorAssessed,
        })),
        graveVer,
    );
    assert(
        (await repo.getSongCasting(grave.id)).find((c) => c.isPrimary)!
            .confidence === "shaky",
        "setSongCasting preserves the member confidence, ignoring the payload",
    );

    // The member CAN set their own confidence (set_my_confidence runs as them; trigger allows).
    const ben = await signInAs("ben@example.com");
    const benMember = (
        await ben.client
            .from("member")
            .select("id")
            .eq("user_id", BEN_UID)
            .single()
    ).data as { id: string };
    const benCast = (
        await ben.client
            .from("casting_visible")
            .select("id, part_id, self_reported_confidence")
            .eq("member_id", benMember.id)
            .limit(1)
            .single()
    ).data as { id: string; part_id: string; self_reported_confidence: string };
    assert(
        benCast.self_reported_confidence === "solid",
        "seed: Ben self-reports solid",
    );
    // set_my_confidence now resolves the casting by (part_id, caller) internally (atomic; Bug3), so it
    // takes p_part, not a pre-resolved casting id.
    await ben.client.rpc("set_my_confidence", {
        p_part: benCast.part_id,
        p_confidence: "shaky",
    });
    const after = (
        await ben.client
            .from("casting_visible")
            .select("self_reported_confidence")
            .eq("id", benCast.id)
            .single()
    ).data as { self_reported_confidence: string };
    assert(
        after.self_reported_confidence === "shaky",
        "a member can set their own confidence (trigger allows self)",
    );

    // A director cannot forge a member's self-report by DELETE + INSERT either. The INSERT
    // guard nulls a non-self confidence; only set_song_casting's vouched re-insert (line above)
    // preserves it. Ana deletes the grave lead casting (Cleo) and re-inserts it with a forged
    // 'solid' directly — RLS permits the write, but the trigger strips the confidence.
    const leadRow = (
        await client
            .from("casting")
            .select("id, ensemble_id, member_id")
            .eq("part_id", leadPart.id)
            .eq("is_primary", true)
            .single()
    ).data as { id: string; ensemble_id: string; member_id: string };
    await client.from("casting").delete().eq("id", leadRow.id);
    const { error: forgeErr } = await client
        .from("casting")
        .insert({
            ensemble_id: leadRow.ensemble_id,
            part_id: leadPart.id,
            member_id: leadRow.member_id,
            is_primary: true,
            self_reported_confidence: "solid",
        });
    assert(
        !forgeErr,
        "the raw re-insert is allowed by RLS (a director may write the row)",
    );
    const forged = (
        await client
            .from("casting")
            .select("self_reported_confidence")
            .eq("part_id", leadPart.id)
            .eq("member_id", leadRow.member_id)
            .single()
    ).data as { self_reported_confidence: string | null };
    assert(
        forged.self_reported_confidence === null,
        "a director-forged confidence is nulled on insert (not-self, no rpc flag)",
    );
}
