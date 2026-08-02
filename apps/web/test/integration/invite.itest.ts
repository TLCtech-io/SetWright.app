// The invite/claim keystone. inviteMember records a pending seat's invite email
// (RLS: director only); claim_membership() binds the seat invited under the caller's GoTrue-VERIFIED
// email (auth.email(), no bearer token), skipping ensembles the caller already belongs to. Seed
// fixtures: Harmony Collective (A) has Ana (director), Ben (member), and two PENDING seats — Cleo
// (invited under rae@example.com) and Dane (invited under ana@example.com). Rae directs Riverside (B).
import { createSupabaseRepository } from "../../lib/supabase/repository";
import { assert, signInAs, serviceClient } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

const ANA_UID = "00000000-0000-0000-0000-0000000000a1";
const RAE_UID = "00000000-0000-0000-0000-0000000000c3";
const HASH = "a".repeat(64); // a placeholder token hash for the inviteMember RLS-path tests

const myEnsemble = async (
    client: SupabaseClient,
    uid: string,
): Promise<string> =>
    (
        (
            await client
                .from("member")
                .select("ensemble_id")
                .eq("user_id", uid)
                .single()
        ).data as { ensemble_id: string }
    ).ensemble_id;

const seatId = async (
    client: SupabaseClient,
    ens: string,
    name: string,
): Promise<string> =>
    (
        (
            await client
                .from("member")
                .select("id")
                .eq("ensemble_id", ens)
                .eq("display_name", name)
                .single()
        ).data as { id: string }
    ).id;

export async function run(): Promise<void> {
    const { client: ana } = await signInAs("ana@example.com");
    const ensA = await myEnsemble(ana, ANA_UID);
    const repoA = createSupabaseRepository(ana, ensA);

    // --- inviteMember (the director's RLS-gated write) ---------------------------
    const fresh = await repoA.createMember({
        displayName: "Newbie",
        role: "member",
        singing: true,
        sections: [],
        rangeLowMidi: null,
        rangeHighMidi: null,
    });
    assert(
        !fresh.claimed && fresh.inviteEmail === null,
        "a freshly created seat is unclaimed with no invite",
    );

    const inv = await repoA.inviteMember(fresh.id, "Newbie@Example.com", HASH);
    assert(inv.ok, "a director can invite a seat by email");
    const afterInvite = (await repoA.listRoster()).find(
        (m) => m.id === fresh.id,
    )!;
    assert(
        afterInvite.inviteEmail === "newbie@example.com" &&
            !afterInvite.claimed,
        "invite_email is recorded (lowercased), seat still pending",
    );

    // refresh_pending_invite (the self-serve resend's pending-seat gate): a member_invite row in an ACTIVE
    // ensemble means a waiting invite. Service-role only, so an authenticated caller cannot enumerate invites.
    const svc = serviceClient();
    assert(
        (
            await svc.rpc("refresh_pending_invite", {
                p_email: "Newbie@Example.com",
            })
        ).data === true,
        "refresh_pending_invite is true (case-insensitive) for an address with a pending seat in an active ensemble",
    );
    assert(
        (
            await svc.rpc("refresh_pending_invite", {
                p_email: "nobody-here@example.com",
            })
        ).data === false,
        "refresh_pending_invite is false for an address with no pending seat",
    );
    assert(
        (
            await ana.rpc("refresh_pending_invite", {
                p_email: "newbie@example.com",
            })
        ).error !== null,
        "refresh_pending_invite is not callable by an authenticated user (no enumeration)",
    );

    // The same address is already pending on Cleo's seat → rejected (the partial unique index).
    const dup = await repoA.inviteMember(fresh.id, "rae@example.com", HASH);
    assert(
        !dup.ok && dup.reason === "duplicate",
        "inviting an email already pending on another seat is rejected",
    );

    // Ana's own seat is already claimed → cannot be (re)invited.
    const anaSeat = await seatId(ana, ensA, "Ana");
    const onClaimed = await repoA.inviteMember(
        anaSeat,
        "whoever@example.com",
        HASH,
    );
    assert(
        !onClaimed.ok && onClaimed.reason === "claimed",
        "cannot invite an already-claimed seat",
    );

    // A non-director (Ben) is denied by RLS (the write matches no row).
    const { client: ben } = await signInAs("ben@example.com");
    const repoBen = createSupabaseRepository(ben, ensA);
    const benTry = await repoBen.inviteMember(
        fresh.id,
        "someoneelse@example.com",
        HASH,
    );
    assert(
        !benTry.ok && benTry.reason === "forbidden",
        "a non-director cannot invite (RLS denies the write)",
    );

    // Invite state lives in the director-only member_invite table, so a non-director
    // reads zero rows — a member can never see a peer's pending invite email via the Data API.
    const benSeesInvites = (
        await ben
            .from("member_invite")
            .select("invite_email")
            .eq("ensemble_id", ensA)
    ).data as unknown[] | null;
    assert(
        (benSeesInvites ?? []).length === 0,
        "a non-director reads zero rows from member_invite (invite emails hidden)",
    );

    // --- claim_membership() (the bind, by VERIFIED email, no bearer token) ----
    // Cleo's seat is invited under rae@example.com. A caller whose verified email matches no pending
    // seat binds nothing; rae's email matches Cleo's seat and binds it. There is no token to present —
    // the bind is by the session's verified email (auth.email()).
    const { client: rae } = await signInAs("rae@example.com");
    const before =
        (
            await rae
                .from("member")
                .select("id", { count: "exact", head: true })
                .eq("user_id", RAE_UID)
        ).count ?? 0;
    // Ben (member of A, ben@example.com) has no pending seat under his address → binds nothing.
    const noMatch = await ben.rpc("claim_membership");
    assert(
        ((noMatch.data ?? []) as unknown[]).length === 0,
        "an email matching no pending seat binds nothing",
    );
    const { data: claimed, error: claimErr } =
        await rae.rpc("claim_membership");
    assert(
        !claimErr,
        `claim_membership runs without error (${claimErr?.message ?? "ok"})`,
    );
    const claimedRows = (claimed ?? []) as Array<{ ensemble_id: string }>;
    assert(
        claimedRows.length === 1 && claimedRows[0]!.ensemble_id === ensA,
        "rae's verified email claims exactly the Harmony Collective seat",
    );
    const after =
        (
            await rae
                .from("member")
                .select("id", { count: "exact", head: true })
                .eq("user_id", RAE_UID)
        ).count ?? 0;
    assert(before === 1 && after === 2, "rae goes from one membership to two");
    const cleoId = await seatId(ana, ensA, "Cleo");
    const cleo = (
        await rae
            .from("member")
            .select("user_id")
            .eq("ensemble_id", ensA)
            .eq("id", cleoId)
            .single()
    ).data as { user_id: string };
    assert(cleo.user_id === RAE_UID, "Cleo's seat is bound to rae");
    // The invite row is deleted on claim (checked as the director, who alone can read the side table).
    const cleoInvite = (
        await ana
            .from("member_invite")
            .select("member_id")
            .eq("ensemble_id", ensA)
            .eq("member_id", cleoId)
    ).data as unknown[] | null;
    assert(
        (cleoInvite ?? []).length === 0,
        "Cleo's invite row is cleared on claim",
    );
    // Transition: with the invite row gone, refresh_pending_invite flips to false for that address -- a
    // claimed invite is no longer resendable (the self-serve resend would send nothing for it).
    assert(
        (
            await svc.rpc("refresh_pending_invite", {
                p_email: "rae@example.com",
            })
        ).data === false,
        "refresh_pending_invite is false once the seat is claimed (invite row gone)",
    );

    // Idempotent: re-running the claim now that the seat is bound (user_id set) binds nothing more.
    const again = await rae.rpc("claim_membership");
    assert(
        ((again.data ?? []) as unknown[]).length === 0,
        "re-claiming is a no-op",
    );

    // Ana already holds a seat in A → even though Dane's seat is invited under ana@example.com, her
    // claim SKIPS that ensemble (the unique (ensemble_id,user_id) guard).
    const { data: anaClaim } = await ana.rpc("claim_membership");
    assert(
        ((anaClaim ?? []) as unknown[]).length === 0,
        "claim skips an ensemble the caller already belongs to",
    );
    const daneId = await seatId(ana, ensA, "Dane");
    const dane = (
        await ana
            .from("member")
            .select("user_id")
            .eq("ensemble_id", ensA)
            .eq("id", daneId)
            .single()
    ).data as { user_id: string | null };
    const daneInvite = (
        await ana
            .from("member_invite")
            .select("invite_email")
            .eq("ensemble_id", ensA)
            .eq("member_id", daneId)
            .maybeSingle()
    ).data as { invite_email: string } | null;
    assert(
        dane.user_id === null && daneInvite?.invite_email === "ana@example.com",
        "Dane's seat stays pending with its invite in the side table",
    );

    // --- 052: the dead-end invite pre-check + ensemble_seat_for_email scoping (Bug audit H3) -----
    // Ben is a claimed active member of A. Inviting a fresh seat under Ben's email is a dead end
    // (claim refuses a second seat per user), so inviteMember blocks it and names him.
    const spare = await repoA.createMember({
        displayName: "Spare",
        role: "member",
        singing: true,
        sections: [],
        rangeLowMidi: null,
        rangeHighMidi: null,
    });
    const already = await repoA.inviteMember(spare.id, "ben@example.com", HASH);
    assert(
        !already.ok &&
            already.reason === "already_member" &&
            already.memberName === "Ben",
        "inviting a claimed active member's email is blocked as already_member, named",
    );

    // Deactivate Ben, then re-invite his email → removed_member (the director reactivates his seat).
    const benSeat = await seatId(ana, ensA, "Ben");
    await repoA.setMemberStatus(benSeat, "inactive");
    const removed = await repoA.inviteMember(spare.id, "ben@example.com", HASH);
    assert(
        !removed.ok &&
            removed.reason === "removed_member" &&
            removed.memberName === "Ben",
        "inviting a REMOVED member's email is blocked as removed_member, named",
    );
    await repoA.setMemberStatus(benSeat, "active"); // restore before the director-gate checks below

    // ensemble_seat_for_email is director-gated + tenant-scoped (it reads auth.users, so a broken gate
    // is a cross-tenant email-enumeration oracle): a non-director resolves nothing; a director resolves
    // nothing for an email whose only claimed seat is in another tenant (rae is claimed in B, not A).
    const benLookup = (
        await ben.rpc("ensemble_seat_for_email", {
            p_ensemble: ensA,
            p_email: "ana@example.com",
        })
    ).data as unknown[] | null;
    assert(
        (benLookup ?? []).length === 0,
        "a non-director caller resolves no seat (director gate holds)",
    );
    // A director cannot fish an arbitrary email: one with no claimed seat in THIS ensemble resolves
    // nothing (the no-enumeration property). (rae, who earlier claimed a seat in A above, would now
    // resolve — she IS in A — so use an address with no seat anywhere.)
    const noSeat = (
        await ana.rpc("ensemble_seat_for_email", {
            p_ensemble: ensA,
            p_email: "nobody-nowhere@example.com",
        })
    ).data as unknown[] | null;
    assert(
        (noSeat ?? []).length === 0,
        "a director resolves no seat for an email with no claimed seat in the ensemble",
    );
}
