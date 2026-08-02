// Member self-service. A member edits their OWN record via update_my_profile
// (display name + range), and the RPC's self-guard means passing someone else's member id is
// a silent no-op (no privilege escalation). Ben is a plain member of Harmony Collective (A).
import { createSupabaseRepository } from "../../lib/supabase/repository";
import { assert, signInAs, sql } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

const ANA_UID = "00000000-0000-0000-0000-0000000000a1";
const BEN_UID = "00000000-0000-0000-0000-0000000000b2";

const memberId = async (
    client: SupabaseClient,
    ens: string,
    uid: string,
): Promise<string> =>
    (
        (
            await client
                .from("member")
                .select("id")
                .eq("ensemble_id", ens)
                .eq("user_id", uid)
                .single()
        ).data as { id: string }
    ).id;
const nameOf = async (client: SupabaseClient, ens: string, name: string) =>
    (
        await client
            .from("member")
            .select("display_name, vocal_range_low")
            .eq("ensemble_id", ens)
            .eq("display_name", name)
            .maybeSingle()
    ).data as { display_name: string; vocal_range_low: number | null } | null;

export async function run(): Promise<void> {
    const { client: ben } = await signInAs("ben@example.com");
    const ensA = (
        (
            await ben
                .from("member")
                .select("ensemble_id")
                .eq("user_id", BEN_UID)
                .single()
        ).data as { ensemble_id: string }
    ).ensemble_id;
    const repo = createSupabaseRepository(ben, ensA);

    const benId = await memberId(ben, ensA, BEN_UID);
    const anaId = await memberId(ben, ensA, ANA_UID); // a member can read the roster

    // Ben edits his own profile.
    const updated = await repo.updateMyProfile(benId, {
        displayName: "Benjamin",
        rangeLowMidi: 48,
        rangeHighMidi: 64,
    });
    assert(
        updated?.displayName === "Benjamin",
        "a member can rename themselves via update_my_profile",
    );
    assert(
        updated?.rangeLowMidi === 48 && updated?.rangeHighMidi === 64,
        "the member can set their own vocal range",
    );
    const reread = await repo.getMember(benId);
    assert(reread?.displayName === "Benjamin", "the self-edit persisted");

    // Ben tries to edit Ana's profile — the RPC's m.user_id = auth.uid() guard makes it a no-op.
    await repo.updateMyProfile(anaId, {
        displayName: "Hacked",
        rangeLowMidi: 0,
        rangeHighMidi: 0,
    });
    const ana = await nameOf(ben, ensA, "Ana");
    assert(
        ana?.display_name === "Ana" && ana?.vocal_range_low !== 0,
        "a member cannot edit another member's profile (self-guard no-op)",
    );

    // --- self-RSVP (set_my_availability) -----------------------------------------
    const eventId = (
        (
            await ben
                .from("event")
                .select("id")
                .eq("ensemble_id", ensA)
                .limit(1)
                .single()
        ).data as { id: string }
    ).id;
    const myStatus = async () =>
        (
            await ben
                .from("availability")
                .select("status")
                .eq("event_id", eventId)
                .eq("member_id", benId)
                .maybeSingle()
        ).data as { status: string } | null;

    await repo.setMyAvailability(eventId, "tentative");
    assert(
        (await myStatus())?.status === "tentative",
        "a member can set their own availability (upsert insert)",
    );
    await repo.setMyAvailability(eventId, "out");
    assert(
        (await myStatus())?.status === "out",
        "setting it again flips the same row (upsert update, no duplicate)",
    );

    // Ben cannot write ANA's availability directly — the availability_write self branch denies it.
    const { error: forge } = await ben
        .from("availability")
        .insert({
            ensemble_id: ensA,
            member_id: anaId,
            event_id: eventId,
            status: "out",
        });
    assert(
        !!forge,
        "a member cannot write another member's availability (RLS denies)",
    );

    // --- my parts + self-confidence (set_my_confidence) --------------------------
    const mine = await repo.listMyCastings();
    assert(
        mine.length > 0,
        "listMyCastings returns the parts the member is cast on",
    );
    assert(
        mine.every((c) => !!c.songTitle && !!c.partLabel),
        "each cast part resolves a song title + part label",
    );
    const part = mine[0]!.partId;

    await repo.setMyConfidence(part, "shaky");
    assert(
        (await repo.listMyCastings()).find((c) => c.partId === part)
            ?.confidence === "shaky",
        "a member can set their own confidence",
    );
    await repo.setMyConfidence(part, null);
    assert(
        (await repo.listMyCastings()).find((c) => c.partId === part)
            ?.confidence === null,
        "a member can clear their confidence (un-report)",
    );

    // --- Bug audit M5: a member reads a setlist as the FROZEN snapshot, never the live drafter -----
    // The GET route serves a member loadFrozenSnapshot (getPublishedSet / getSharedDraft); this proves
    // the member's frozen-read path returns a clean set (songs only, no drafter bench/drops/catalog).
    // The seed's Winter-showcase set is performed → member-visible; find whichever gig has one.
    let frozen: Awaited<ReturnType<typeof repo.getPublishedSet>> | undefined;
    for (const ev of await repo.listEvents()) {
        const visible = (await repo.listEventSetlists(ev.id)).find(
            (m) => m.status === "performed" || m.publishedAt != null,
        );
        if (visible) {
            frozen = await repo.getPublishedSet(visible.id);
            break;
        }
    }
    assert(
        !!frozen && frozen.songs.length > 0,
        "a member reads a frozen snapshot (getPublishedSet) with its songs, no drafter run",
    );

    // --- email mirror stays fresh on an email change (on_auth_user_updated trigger) ---------------
    // app_user.email is a convenience mirror; auth is canonical. handle_new_user seeds it on INSERT,
    // but a self-service email change updates auth.users.email later, so the on_auth_user_updated
    // trigger must re-mirror it or the mirror goes stale. Drive the change as a raw auth.users.email
    // UPDATE — exactly the column write GoTrue makes when a confirmed change lands (the e2e exercises
    // that end to end; the admin API would only STAGE a pending change, never firing the trigger) —
    // and assert the mirror followed.
    const newEmail = "ben.updated@example.com";
    const before = sql(
        `select email from public.app_user where id = '${BEN_UID}';`,
    );
    assert(
        before === "ben@example.com",
        "the mirror starts at the seeded address",
    );
    sql(`update auth.users set email = '${newEmail}' where id = '${BEN_UID}';`);
    const after = sql(
        `select email from public.app_user where id = '${BEN_UID}';`,
    );
    assert(
        after === newEmail,
        "app_user.email mirror follows the auth.users email change",
    );
}
