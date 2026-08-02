// Run with: npm test
//
// Drafting into a specific setlist: the pins map to the drafter's options, the
// cardinality guard rejects an over-pinned setlist, and a missing setlist is a
// 404. A fake source feeds the locks and the event pool, so no database is
// needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { breaksOf, songsOf } from "@repertoire/core";
import {
    draftSetForSetlist,
    sequenceForOrder,
    supabaseHydrationSource,
    type SupabaseRpcClient,
} from "../src/index.js";
import {
    payload,
    payloadWithDormant,
    locks,
    setlistSource,
} from "./fixture.js";

test("open and close pins fix the ends of the set", async () => {
    // Pin against the natural s1..s3 order: s3 opens, s1 closes. The assertion can
    // only hold if the pins are honored, not by coincidence of the unpinned arc.
    const r = await draftSetForSetlist(
        setlistSource(payload(), locks({ opens: ["s3"], closes: ["s1"] })),
        "sl1",
    );
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    const setSongs = songsOf(r.body.set);
    assert.equal(setSongs[0]!.song.id, "s3");
    assert.equal(setSongs[setSongs.length - 1]!.song.id, "s1");
});

test("an excluded pin bars the song from the set", async () => {
    const r = await draftSetForSetlist(
        setlistSource(payload(), locks({ excluded: ["s2"] })),
        "sl1",
    );
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.ok(
        !songsOf(r.body.set)
            .map((e) => e.song.id)
            .includes("s2"),
    );
});

test("a keep pin forces in a song the gates would otherwise drop", async () => {
    const p = payloadWithDormant();

    const plain = await draftSetForSetlist(setlistSource(p, locks()), "sl1");
    assert.equal(plain.status, 200);
    if (plain.status !== 200) return;
    assert.ok(
        !songsOf(plain.body.set)
            .map((e) => e.song.id)
            .includes("s9"),
        "s9 drops without keep",
    );

    const kept = await draftSetForSetlist(
        setlistSource(p, locks({ keep: ["s9"] })),
        "sl1",
    );
    assert.equal(kept.status, 200);
    if (kept.status !== 200) return;
    assert.ok(
        songsOf(kept.body.set)
            .map((e) => e.song.id)
            .includes("s9"),
        "s9 forced in by keep",
    );
});

test("a setlist break reserves budget, segments the set, and renders one break", async () => {
    const noBreak = await draftSetForSetlist(
        setlistSource(payload(), locks()),
        "sl1",
    );
    const withBreak = await draftSetForSetlist(
        setlistSource(
            payload(),
            locks({
                breaks: [
                    {
                        id: "b1",
                        label: "Intermission",
                        durationSeconds: 300,
                        afterPosition: 1,
                    },
                ],
            }),
        ),
        "sl1",
    );
    assert.equal(noBreak.status, 200);
    if (noBreak.status !== 200) return;
    assert.equal(withBreak.status, 200);
    if (withBreak.status !== 200) return;
    // The break renders, and reserving its time fits no more songs than without it.
    assert.equal(breaksOf(withBreak.body.set).length, 1);
    assert.ok(
        songsOf(withBreak.body.set).length <= songsOf(noBreak.body.set).length,
    );
    // Seams are within-segment only: the break boundary drops one song-song seam.
    assert.equal(
        withBreak.body.seams.length,
        Math.max(0, songsOf(withBreak.body.set).length - 1 - 1),
    );
});

test("a missing or invisible setlist returns 404", async () => {
    const nullEvent = await draftSetForSetlist(
        setlistSource(payload(), locks({ eventId: null })),
        "missing",
    );
    assert.equal(nullEvent.status, 404);

    const noDoc = await draftSetForSetlist(
        setlistSource(payload(), null),
        "missing",
    );
    assert.equal(noDoc.status, 404);
});

test("more than one open or close pin returns 422", async () => {
    const twoOpens = await draftSetForSetlist(
        setlistSource(payload(), locks({ opens: ["s1", "s2"] })),
        "sl1",
    );
    assert.equal(twoOpens.status, 422);

    const twoCloses = await draftSetForSetlist(
        setlistSource(payload(), locks({ closes: ["s1", "s3"] })),
        "sl1",
    );
    assert.equal(twoCloses.status, 422);
});

test("malformed lock lists are tolerated, not crashed on", async () => {
    const r = await draftSetForSetlist(
        setlistSource(payload(), {
            eventId: "ev1",
            opens: "not-an-array",
            closes: null,
            keep: [1, 2],
            excluded: undefined,
        }),
        "sl1",
    );
    assert.equal(r.status, 200); // coerced to empty pins, drafts as a fresh set
});

test("the supabase adapter reads setlist locks via its own rpc", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ok: SupabaseRpcClient = {
        rpc: (fn, args) => {
            calls.push([fn, args]);
            return Promise.resolve({
                data: {
                    eventId: "ev1",
                    opens: [],
                    closes: [],
                    keep: [],
                    excluded: [],
                },
                error: null,
            });
        },
    };
    const data = await supabaseHydrationSource(ok).hydrateLocks("sl1");
    assert.deepEqual(calls[0], ["hydrate_setlist_locks", { p_setlist: "sl1" }]);
    assert.deepEqual(data, {
        eventId: "ev1",
        opens: [],
        closes: [],
        keep: [],
        excluded: [],
    });
});

test("draftSetForSetlist applies the persisted arranged order exactly (Bug5)", async () => {
    const canonical = await draftSetForSetlist(
        setlistSource(payload(), locks()),
        "sl1",
    );
    assert.equal(canonical.status, 200);
    if (canonical.status !== 200) return;
    const canonIds = songsOf(canonical.body.set).map((e) => e.song.id);
    assert.ok(canonIds.length >= 2, "need >= 2 songs to reorder");
    // Reverse the canonical order as the director's manual arrangement; the draft must present it verbatim.
    const arranged = [...canonIds].reverse();
    const r = await draftSetForSetlist(
        setlistSource(payload(), locks()),
        "sl1",
        undefined,
        undefined,
        undefined,
        arranged,
    );
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.deepEqual(
        songsOf(r.body.set).map((e) => e.song.id),
        arranged,
        "the set is presented in the arranged order",
    );
});

test("draftSetForSetlist reconciles a stale/partial arranged order (drops ghosts, appends new, keeps membership) (Bug5)", async () => {
    const canonical = await draftSetForSetlist(
        setlistSource(payload(), locks()),
        "sl1",
    );
    if (canonical.status !== 200) return;
    const canonIds = songsOf(canonical.body.set).map((e) => e.song.id);
    // Arranged order names only the LAST canonical song plus a ghost id: the ghost drops, the named
    // song leads, the rest append in the drafter's order, and membership is unchanged.
    const arranged = [canonIds[canonIds.length - 1]!, "ghost"];
    const r = await draftSetForSetlist(
        setlistSource(payload(), locks()),
        "sl1",
        undefined,
        undefined,
        undefined,
        arranged,
    );
    if (r.status !== 200) return;
    const got = songsOf(r.body.set).map((e) => e.song.id);
    assert.equal(got[0], canonIds[canonIds.length - 1], "the named song leads");
    assert.ok(!got.includes("ghost"), "the ghost id is dropped");
    assert.equal(
        got.length,
        canonIds.length,
        "membership unchanged — only order is overridden",
    );
});

test("sequenceForOrder normalizes an out-of-range break (clamps it in) instead of dropping it", async () => {
    const order = ["s1", "s2", "s3"];
    // afterPosition 5 is past the 3-song set; the draft path clamps it to the last valid slot and
    // counts it, so the re-cost must too. Raw (unnormalized) would silently drop it — the bug.
    const withOOR = await sequenceForOrder(
        setlistSource(
            payload(),
            locks({
                breaks: [
                    {
                        id: "b1",
                        label: "Intermission",
                        durationSeconds: 300,
                        afterPosition: 5,
                    },
                ],
            }),
        ),
        "sl1",
        order,
    );
    const noBreak = await sequenceForOrder(
        setlistSource(payload(), locks()),
        "sl1",
        order,
    );
    assert.equal(withOOR.status, 200);
    if (withOOR.status !== 200) return;
    assert.equal(noBreak.status, 200);
    if (noBreak.status !== 200) return;
    // The clamped break splits the order into segments, dropping exactly one song-song seam vs no
    // break, and its 300s is charged on the clock. If it were dropped, both would be identical.
    assert.equal(withOOR.body.seams.length, noBreak.body.seams.length - 1);
    assert.ok(withOOR.body.totalSeconds > noBreak.body.totalSeconds);
});

test("sequenceForOrder re-sequences the given songs, keeping every one", async () => {
    const r = await sequenceForOrder(setlistSource(payload(), locks()), "sl1", [
        "s3",
        "s1",
        "s2",
    ]);
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    // Same set, re-ordered — arrange never adds or drops a song (that is a re-draft).
    assert.deepEqual([...r.body.order].sort(), ["s1", "s2", "s3"]);
    assert.equal(r.body.seams.length, 2); // three songs, two seams
    assert.ok(r.body.totalSeconds > 0);
});

test("sequenceForOrder honors the opener and closer pins", async () => {
    const r = await sequenceForOrder(
        setlistSource(payload(), locks({ opens: ["s3"], closes: ["s1"] })),
        "sl1",
        ["s1", "s2", "s3"],
    );
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.equal(r.body.order[0], "s3");
    assert.equal(r.body.order[r.body.order.length - 1], "s1");
});

test("sequenceForOrder drops ids that are not in the pool", async () => {
    const r = await sequenceForOrder(setlistSource(payload(), locks()), "sl1", [
        "s1",
        "ghost",
        "s2",
    ]);
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.deepEqual([...r.body.order].sort(), ["s1", "s2"]);
});

test("sequenceForOrder returns 404 for a missing or invisible setlist", async () => {
    const r = await sequenceForOrder(
        setlistSource(payload(), locks({ eventId: null })),
        "missing",
        ["s1"],
    );
    assert.equal(r.status, 404);
});
