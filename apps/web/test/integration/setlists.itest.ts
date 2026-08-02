// Setlists: CRUD, the frozen performed read, history, soloists, and the
// position-writing methods (pins, notes, segues, perform, clone).
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    const { repo, client } = await signInAs("ana@example.com");
    const songs = await repo.listSongs();
    const id = (t: string) => songs.find((s) => s.title.startsWith(t))!.id;
    const wade = id("Wade");
    const lean = id("Lean");
    const stand = id("Stand");
    const grave = id("Ain't No Grave");
    const bridge = id("Bridge");
    const concert = (await repo.listEvents()).find(
        (e) => e.name === "Summer concert",
    )!;
    const sl = (await repo.getEventSetlists(concert.id))[0]!;
    const winterSl = (
        await client
            .from("setlist")
            .select("id")
            .eq("status", "performed")
            .single()
    ).data!.id as string;
    const locks = (slid: string) =>
        client.rpc("hydrate_setlist_locks", { p_setlist: slid }).then(
            (r) =>
                r.data as {
                    opens: string[];
                    closes: string[];
                    keep: string[];
                    excluded: string[];
                },
        );

    // CRUD + lock
    assert(
        (await repo.getSetlistMeta(sl))?.name === "Main set",
        "getSetlistMeta",
    );
    assert((await repo.setlistLockReason(sl)) === null, "draft is editable");
    assert(
        (await repo.setlistLockReason(winterSl)) ===
            "a performed set is read-only",
        "performed set is locked",
    );
    const setB = await repo.createSetlist(concert.id, "Set B");
    assert(
        (await repo.updateSetlist(setB!.id, { status: "final" }))?.status ===
            "final",
        "updateSetlist finalizes",
    );
    assert(
        (await repo.setlistLockReason(setB!.id))?.includes("finalized"),
        "final set is locked",
    );
    assert(
        (await repo.updateSetlist(winterSl, { name: "nope" })) === undefined,
        "updateSetlist refuses a performed set",
    );
    assert(
        (await repo.deleteSetlist(setB!.id)).ok,
        "deleteSetlist removes a draft",
    );
    assert(
        (await repo.deleteSetlist(winterSl)).ok === false,
        "deleteSetlist refuses a performed set",
    );

    // Performed / frozen read
    const perf = (await repo.getPerformedSet(winterSl))!;
    assert(
        perf.songs.map((s) => s.title).join("|") ===
            "Lean on Me|Stand By Me|Bridge Over Troubled Water|Wade in the Water",
        "frozen order",
    );
    assert(
        perf.notes[perf.songs[2]!.id] === "Soft open, let the room settle",
        "frozen note",
    );
    assert(perf.transitions[perf.songs[1]!.id] === 0, "frozen segue (attacca)");
    assert(
        perf.breaks.length === 1 && perf.breaks[0]!.afterPosition === 2,
        "frozen break",
    );
    assert(
        perf.padding.perSongSeconds === 30 && perf.date === "2026-02-14",
        "frozen padding + date from the event",
    );

    // History + soloists
    const hist = await repo.getSetlistHistory();
    assert(
        hist.length === 1 && hist[0]!.titles.length === 4,
        "history: 1 set, 4 titles",
    );
    const solos = await repo.listSoloistAppearances();
    assert(
        solos.length === 4 &&
            solos.filter((s) => s.displayName === "Ana").length === 3,
        "4 soloist appearances, Ana 3",
    );
    assert(
        solos.some((s) => s.displayName === "Dane"),
        "Dane appears as a soloist",
    );

    // Item reads + breaks
    assert(
        (await repo.getItemNotes(winterSl, [perf.songs[2]!.id]))[
            perf.songs[2]!.id
        ] === "Soft open, let the room settle",
        "getItemNotes",
    );
    assert(
        (await repo.getTransitions(winterSl, [perf.songs[1]!.id]))[
            perf.songs[1]!.id
        ] === 0,
        "getTransitions",
    );
    assert((await repo.getBreaks(winterSl)).length === 1, "getBreaks");

    // Writes: notes / segues (upsert + clear)
    assert(await repo.setItemNote(sl, wade, "Watch the key"), "setItemNote");
    assert(
        (await repo.getItemNotes(sl, [wade]))[wade] === "Watch the key",
        "note round-trips",
    );
    await repo.setItemNote(sl, wade, "");
    assert(
        Object.keys(await repo.getItemNotes(sl, [wade])).length === 0,
        "empty note removes the row",
    );
    await repo.setTransition(sl, lean, 0);
    assert(
        (await repo.getTransitions(sl, [lean]))[lean] === 0,
        "segue round-trips",
    );
    await repo.setTransition(sl, lean, null);
    assert(
        Object.keys(await repo.getTransitions(sl, [lean])).length === 0,
        "null segue removes the row",
    );

    // Writes: pins (via hydrate_setlist_locks) + note preservation
    await repo.setItemNote(sl, stand, "keep me");
    await repo.setPins(sl, {
        open: wade,
        close: lean,
        keep: [stand],
        excluded: [grave],
    });
    const L = await locks(sl);
    assert(
        L.opens[0] === wade &&
            L.closes[0] === lean &&
            L.keep.includes(stand) &&
            L.excluded.includes(grave),
        "setPins open/close/keep/excluded",
    );
    assert(
        (await repo.getItemNotes(sl, [stand]))[stand] === "keep me",
        "setPins preserved a note on a kept song",
    );

    // Writes: markPerformed (freeze + soloists + last_performed)
    const fresh = (await repo.createSetlist(concert.id, "Perf Test"))!;
    const solosBefore = (await repo.listSoloistAppearances()).length;
    assert(
        await repo.markPerformed(fresh.id, [wade, lean, stand]),
        "markPerformed",
    );
    assert(
        (await repo.getPerformedSet(fresh.id))!.songs
            .map((s) => s.title)
            .join(",") === "Wade in the Water,Lean on Me,Stand By Me",
        "frozen order from markPerformed",
    );
    assert(
        (await repo.markPerformed(fresh.id, [wade])) === false,
        "markPerformed refuses to re-freeze",
    );
    assert(
        (await repo.listSoloistAppearances()).length === solosBefore + 3,
        "3 soloists snapshotted",
    );
    assert(
        (await repo.listSongs()).find((s) => s.title.startsWith("Wade"))!
            .lastPerformed === concert.resolved.eventDate,
        "last_performed stamped to the concert date",
    );

    // performed_date is durable: changing the event date must not rewrite history.
    await client
        .from("event")
        .update({ event_date: "2099-12-31" })
        .eq("id", concert.id);
    assert(
        (await repo.getPerformedSet(fresh.id))!.date ===
            concert.resolved.eventDate,
        "performed date stays frozen when the event date changes",
    );

    // Editing a SONG after the set is performed must not rewrite the frozen record either.
    // getPerformedSet reads the perform-time snapshot, not the live song, so the
    // frozen title + duration hold while the live song changes. The date test above edits the event;
    // this edits the song itself, exercising the frozen-vs-live snapshot read path directly.
    const frozenWade = (await repo.getPerformedSet(fresh.id))!.songs.find(
        (s) => s.id === wade,
    )!;
    const frozenTitle = frozenWade.title;
    const frozenDur = frozenWade.durationSeconds;
    await client
        .from("song")
        .update({ title: "RENAMED AFTER PERFORM", duration_seconds: 4321 })
        .eq("id", wade);
    const afterSongEdit = (await repo.getPerformedSet(fresh.id))!.songs.find(
        (s) => s.id === wade,
    )!;
    assert(
        afterSongEdit.title === frozenTitle &&
            afterSongEdit.durationSeconds === frozenDur,
        "a performed set freezes song metadata: editing the song does not rewrite the frozen sheet or total",
    );
    assert(
        (await repo.getSong(wade))!.title === "RENAMED AFTER PERFORM",
        "the live song DID change (so the frozen read is a real snapshot, not a coincidental no-op)",
    );
    // Restore the live song so later title-prefix lookups and other domains are unaffected.
    await client
        .from("song")
        .update({ title: frozenTitle, duration_seconds: frozenDur })
        .eq("id", wade);

    // Writes: cloneSetlist
    const clone = await repo.cloneSetlist(winterSl, concert.id);
    assert(
        clone?.status === "draft" && clone?.name?.includes("clone"),
        "cloneSetlist makes a draft",
    );
    const cl = await locks(clone!.id);
    assert(
        cl.opens[0] === lean &&
            cl.closes[0] === wade &&
            cl.keep.includes(stand) &&
            cl.keep.includes(bridge),
        "clone pins ends + keeps interior",
    );
    assert(
        (await repo.cloneSetlist(sl, concert.id)) === undefined,
        "cloneSetlist refuses a non-performed source",
    );

    // Concurrency: two authenticated clients freeze the SAME set at once. perform_setlist
    // takes a row lock (`for update of s`) before checking status, so the second blocks and then
    // sees 'performed' — exactly one wins. Without the lock both read 'draft' and both froze, the
    // second clobbering the first (live probe: 11/12 double-success).
    const race = (await repo.createSetlist(concert.id, "Race Test"))!;
    const other = (await signInAs("ana@example.com")).repo;
    const outcomes = await Promise.all([
        repo.markPerformed(race.id, [wade, lean]),
        other.markPerformed(race.id, [wade, lean]),
    ]);
    assert(
        outcomes.filter((x) => x === true).length === 1,
        "exactly one concurrent freeze wins (perform_setlist serializes)",
    );
    assert(
        (await repo.getPerformedSet(race.id))!.songs.length === 2,
        "the winning freeze materialized the order once",
    );

    // perform_setlist dedupes + bounds the order directly (a direct PostgREST call bypasses the
    // route's coerceIdList cap): a duplicate must be frozen once, never bumped to a stale position.
    // perform_setlist takes a 3-arg signature (p_setlist, p_order, p_snapshot jsonb, folded into the
    // status flip); a null snapshot is valid (reads fall back to live) and this probe only checks the
    // frozen order.
    const dup = (await repo.createSetlist(concert.id, "Dup Test"))!;
    const dupRes = await client.rpc("perform_setlist", {
        p_setlist: dup.id,
        p_order: [wade, wade, lean],
        p_snapshot: null,
    });
    assert(
        dupRes.error === null && dupRes.data === true,
        "perform_setlist accepts a duplicate order",
    );
    const dupRows = (
        await client
            .from("setlist_item")
            .select("song_id, position")
            .eq("setlist_id", dup.id)
            .order("position")
    ).data as { song_id: string; position: number }[];
    assert(dupRows.length === 2, "a duplicate song is frozen once, not twice");
    assert(
        dupRows[0]!.position === 1 && dupRows[1]!.position === 2,
        "positions are contiguous 1..2, not bumped past a duplicate",
    );
    assert(
        dupRows[0]!.song_id === wade && dupRows[1]!.song_id === lean,
        "first-occurrence order is preserved",
    );

    // Soloist history independence: deleting a solo part (as a chart edit does) must NOT
    // erase its performed soloist appearance. The display fields are frozen on the snapshot, so
    // Dane's bridge solo survives the part going away. Before the FK-cascade was dropped, this
    // delete cascaded the historical row out of existence.
    const bridgeSoloId = (
        await client
            .from("part")
            .select("id")
            .eq("song_id", bridge)
            .eq("is_solo", true)
            .single()
    ).data!.id as string;
    const before = await repo.listSoloistAppearances();
    const daneBefore = before.filter((s) => s.displayName === "Dane").length;
    await client.from("part").delete().eq("id", bridgeSoloId);
    const after = await repo.listSoloistAppearances();
    assert(
        after.length === before.length,
        "deleting a solo part leaves soloist history intact (no cascade)",
    );
    assert(
        after.filter((s) => s.displayName === "Dane").length === daneBefore &&
            daneBefore >= 1,
        "the soloist of the deleted part keeps their frozen name",
    );
    assert(
        after.some((s) => s.songTitle === "Bridge Over Troubled Water"),
        "the frozen song title survives the part deletion",
    );

    // DB-enforced immutability: a direct authenticated write cannot mutate or delete a
    // performed set, its frozen children, or an event with performed history -- the app checks
    // are bypassed, so these are stopped by triggers. A live probe previously deleted a performed
    // set and all its soloists straight through the API.
    const evWinter = (
        await client
            .from("setlist")
            .select("event_id")
            .eq("id", winterSl)
            .single()
    ).data!.event_id as string;
    assert(
        (
            await client
                .from("setlist")
                .update({ name: "hacked" })
                .eq("id", winterSl)
        ).error !== null,
        "direct update of a performed setlist is blocked",
    );
    assert(
        (await client.from("setlist").delete().eq("id", winterSl)).error !==
            null,
        "direct delete of a performed setlist is blocked",
    );
    assert(
        (await client.from("setlist_item").delete().eq("setlist_id", winterSl))
            .error !== null,
        "direct delete of a performed set's items is blocked",
    );
    assert(
        (
            await client
                .from("performance_soloist")
                .delete()
                .eq("setlist_id", winterSl)
        ).error !== null,
        "direct delete of a performed set's soloists is blocked",
    );
    assert(
        (await client.from("event").delete().eq("id", evWinter)).error !== null,
        "direct delete of an event with performed history is blocked",
    );
    assert(
        (await repo.getPerformedSet(winterSl)) !== null,
        "the performed set survived every delete attempt",
    );

    // ...and a director cannot APPEND new rows to a frozen set either (the child-row INSERT guard).
    // Each is a genuinely new key (a new break ordinal / an excluded song / a new soloist part),
    // so the parent setlist row is untouched -- only the child INSERT trigger stops it.
    const winterEns = (
        await client
            .from("setlist")
            .select("ensemble_id")
            .eq("id", winterSl)
            .single()
    ).data!.ensemble_id as string;
    assert(
        (
            await client.from("setlist_break").insert({
                ensemble_id: winterEns,
                setlist_id: winterSl,
                label: "Sneak",
                duration_seconds: 60,
                after_position: 3,
            })
        ).error !== null,
        "direct insert of a break into a performed set is blocked",
    );
    assert(
        (
            await client.from("setlist_item").insert({
                ensemble_id: winterEns,
                setlist_id: winterSl,
                song_id: grave,
                position: null,
                pin: null,
                is_excluded: true,
            })
        ).error !== null,
        "direct insert of an item into a performed set is blocked",
    );
    assert(
        (
            await client.from("performance_soloist").insert({
                ensemble_id: winterEns,
                setlist_id: winterSl,
                song_id: grave,
                part_id: "00000000-0000-0000-0000-0000000000ff",
                member_id: "00000000-0000-0000-0000-0000000000fe",
                song_title: "X",
                part_label: "Y",
                member_display_name: "Z",
            })
        ).error !== null,
        "direct insert of a soloist into a performed set is blocked",
    );

    // ...nor RE-PARENT a frozen child out of the performed set (the old-parent guard), nor flip
    // a draft straight to performed bypassing perform_setlist (the perform_writer guard).
    const draftSl = (
        await client
            .from("setlist")
            .select("id")
            .eq("status", "draft")
            .limit(1)
            .single()
    ).data!.id as string;
    const winterItem = (
        await client
            .from("setlist_item")
            .select("id")
            .eq("setlist_id", winterSl)
            .limit(1)
            .single()
    ).data!.id as string;
    assert(
        (
            await client
                .from("setlist_item")
                .update({ setlist_id: draftSl })
                .eq("id", winterItem)
        ).error !== null,
        "a frozen item cannot be re-parented out of a performed set",
    );
    assert(
        (
            await client
                .from("setlist")
                .update({ status: "performed", performed_date: "2026-01-01" })
                .eq("id", draftSl)
        ).error !== null,
        "a draft setlist cannot be flipped to performed directly",
    );
    assert(
        (
            await client
                .from("setlist")
                .select("status")
                .eq("id", draftSl)
                .single()
        ).data!.status === "draft",
        "the draft setlist stayed a draft",
    );

    // The three draft-write RPCs (set_pins / set_item_field / set_breaks) reject a
    // non-draft set at the DB boundary. A FINAL set has no immutability trigger of its own (unlike a
    // performed set, guarded above), so this status assertion inside each RPC is the only thing stopping
    // a direct-PostgREST edit of a set the app considers locked. The draft happy-path is covered above
    // (repo.setPins / setItemNote on `sl`), so here we only prove the non-draft rejection.
    const finalGuard = (await repo.createSetlist(
        concert.id,
        "Final Guard Test",
    ))!;
    assert(
        (await repo.updateSetlist(finalGuard.id, { status: "final" }))
            ?.status === "final",
        "set up a final set",
    );
    const finalVer = (
        await client
            .from("setlist")
            .select("updated_at")
            .eq("id", finalGuard.id)
            .single()
    ).data!.updated_at as string;
    assert(
        (
            await client.rpc("set_pins", {
                p_setlist: finalGuard.id,
                p_open: wade,
                p_close: null,
                p_keep: [],
                p_excluded: [],
            })
        ).error !== null,
        "set_pins is rejected on a final (non-draft) set",
    );
    assert(
        (
            await client.rpc("set_item_field", {
                p_setlist: finalGuard.id,
                p_song: wade,
                p_field: "note",
                p_note: "x",
                p_seconds: null,
            })
        ).error !== null,
        "set_item_field is rejected on a final set",
    );
    assert(
        (
            await client.rpc("set_breaks", {
                p_setlist: finalGuard.id,
                p_expected: finalVer,
                p_rows: [],
            })
        ).error !== null,
        "set_breaks is rejected on a final set",
    );

    // The guard only fires for performed parents: a draft setlist with items still deletes,
    // its children cascading away cleanly.
    const tmp = (await repo.createSetlist(concert.id, "Tmp"))!;
    await repo.setItemNote(tmp.id, wade, "x");
    assert(
        (await repo.deleteSetlist(tmp.id)).ok,
        "a draft setlist with items still deletes (children cascade past the guard)",
    );

    // --- Bug audit #4: the shared-draft resync bumps the version PAST set_breaks' own return -------
    // This is why the /breaks (and /transition, /order) routes re-read getSetlistMeta().version before
    // handing the token back — else the editor re-seeds a stale token and every later break edit 409s.
    const shared = (await repo.createSetlist(
        concert.id,
        "Shared Version Test",
    ))!;
    await repo.shareSetlistDraft(shared.id, {
        songIds: [],
        transitions: {},
        breaks: [],
    });
    const v0 = (await repo.getSetlistMeta(shared.id))!.version!;
    const brk = await repo.setBreaks(
        shared.id,
        [
            {
                id: crypto.randomUUID(),
                label: "Intermission",
                durationSeconds: 300,
                afterPosition: 1,
            },
        ],
        v0,
    );
    if (!brk.ok) throw new Error("break save on the shared draft failed");
    await repo.syncSharedDraftOrder(shared.id, {
        songIds: [],
        transitions: {},
        breaks: [],
    });
    const vAfter = (await repo.getSetlistMeta(shared.id))!.version!;
    assert(
        vAfter !== brk.version,
        "the resync bumps the version past set_breaks' return — the route must re-read it",
    );

    // --- Bug audit Bug5: arranged_order round-trips and clears -------------------------------------
    const arr = (await repo.createSetlist(concert.id, "Arranged Order Test"))!;
    assert(
        (await repo.getArrangedOrder(arr.id)) === null,
        "a fresh draft has no arranged order",
    );
    await repo.setArrangedOrder(arr.id, [wade]);
    assert(
        JSON.stringify(await repo.getArrangedOrder(arr.id)) ===
            JSON.stringify([wade]),
        "arranged order persists",
    );
    await repo.setArrangedOrder(arr.id, null);
    assert(
        (await repo.getArrangedOrder(arr.id)) === null,
        "arranged order clears to null",
    );

    // --- Published set stays live for members: the director's edits refresh the frozen snapshot ------
    // Publish captures an order, but a published-not-performed set is still editable, so
    // syncPublishedOrder refreshes what members read WITHOUT an unpublish/republish, and WITHOUT moving
    // published_at. The guarded UPDATE (published_at is not null AND status <> 'performed') is a no-op
    // for an unpublished or performed set. A member reads the refreshed order through RLS, which is the
    // whole point: the director's post-publish edit reaches the member side.
    const live = (await repo.createSetlist(concert.id, "Live Publish Test"))!;
    const pub0 = await repo.publishSetlist(live.id, {
        songIds: [wade, lean, stand],
        transitions: {},
        breaks: [],
    });
    assert(
        pub0?.publishedAt != null,
        "the set is published (published_at set)",
    );
    const at0 = pub0!.publishedAt;
    assert(
        (await repo.getPublishedSet(live.id))!.songs
            .map((s) => s.id)
            .join(",") === [wade, lean, stand].join(","),
        "members see the published order",
    );

    await repo.syncPublishedOrder(live.id, {
        songIds: [stand, wade, lean],
        transitions: {},
        breaks: [],
    });
    assert(
        (await repo.getPublishedSet(live.id))!.songs
            .map((s) => s.id)
            .join(",") === [stand, wade, lean].join(","),
        "the published order tracks the edit (no republish)",
    );
    assert(
        (await repo.getSetlistMeta(live.id))!.publishedAt === at0,
        "published_at is unchanged by the refresh (still the original publish time)",
    );

    // A member (Ben, same ensemble) reads the refreshed order through RLS: the edit reached members.
    const { repo: benRepo } = await signInAs("ben@example.com");
    assert(
        (await benRepo.getPublishedSet(live.id))!.songs
            .map((s) => s.id)
            .join(",") === [stand, wade, lean].join(","),
        "a member sees the director's post-publish reorder without a republish",
    );

    // Guards: the refresh never publishes an unpublished set, and never touches a performed record.
    const unpub = (await repo.createSetlist(
        concert.id,
        "Unpublished Refresh Test",
    ))!;
    await repo.syncPublishedOrder(unpub.id, {
        songIds: [wade],
        transitions: {},
        breaks: [],
    });
    assert(
        (await repo.getPublishedSet(unpub.id)) == null,
        "a refresh does not publish an unpublished set (guard holds)",
    );
    const winterOrder = (await repo.getPerformedSet(winterSl))!.songs
        .map((s) => s.id)
        .join(",");
    await repo.syncPublishedOrder(winterSl, {
        songIds: [wade],
        transitions: {},
        breaks: [],
    });
    assert(
        (await repo.getPerformedSet(winterSl))!.songs
            .map((s) => s.id)
            .join(",") === winterOrder,
        "a performed set is never refreshed (the UPDATE matches zero rows, no trigger)",
    );

    // A set that is BOTH published and shared (share, then publish) must keep BOTH snapshots current, or
    // unpublishing later exposes a stale shared draft. resyncMemberSnapshot refreshes both; here we drive
    // the repo primitives it calls, then prove the post-unpublish member read is the CURRENT order.
    const dual = (await repo.createSetlist(
        concert.id,
        "Dual Visibility Test",
    ))!;
    await repo.shareSetlistDraft(dual.id, {
        songIds: [wade, lean],
        transitions: {},
        breaks: [],
    });
    await repo.publishSetlist(dual.id, {
        songIds: [wade, lean],
        transitions: {},
        breaks: [],
    });
    await repo.syncPublishedOrder(dual.id, {
        songIds: [lean, wade],
        transitions: {},
        breaks: [],
    });
    await repo.syncSharedDraftOrder(dual.id, {
        songIds: [lean, wade],
        transitions: {},
        breaks: [],
    });
    assert(
        (await repo.getPublishedSet(dual.id))!.songs
            .map((s) => s.id)
            .join(",") === [lean, wade].join(","),
        "while published, members read the current published order",
    );
    await repo.unpublishSetlist(dual.id);
    assert(
        (await repo.getPublishedSet(dual.id)) == null,
        "unpublish clears the published snapshot",
    );
    assert(
        (await repo.getSharedDraft(dual.id))!.songs
            .map((s) => s.id)
            .join(",") === [lean, wade].join(","),
        "after unpublish the shared-draft fallback shows the current order, not a stale one",
    );
}
