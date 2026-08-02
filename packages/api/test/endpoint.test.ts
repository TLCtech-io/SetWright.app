// Run with: npm test
//
// The endpoint without a database: a fake HydrationSource feeds the JSON the SQL
// would return, so the mapper, the draftSet call, and the response shape are all
// exercised. The real Supabase rpc round-trip needs a live instance and is
// deferred to integration.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SEQUENCE_CONFIG, songsOf } from "@repertoire/core";
import {
    draftSetForEvent,
    seamsForOrder,
    toDraftInput,
    supabaseHydrationSource,
    type SupabaseRpcClient,
} from "../src/index.js";
import { payload, sourceOf } from "./fixture.js";

test("the mapper folds excludeTags, preferTags, and requireTags into options.context", () => {
    const p = payload({
        excludeTags: ["holiday"],
        preferTags: ["upbeat"],
        requireTags: ["gospel"],
    });
    const input = toDraftInput(p);
    assert.deepEqual(input.options?.context, {
        excludeTags: ["holiday"],
        preferTags: ["upbeat"],
        requireTags: ["gospel"],
    });
    // The arrays pass through by reference, no copy and no reshape.
    assert.equal(input.songs, p.songs);
    assert.equal(input.event, p.event);
    assert.equal(input.members, p.members);
});

test("a null or absent event returns 404", async () => {
    const nothing = await draftSetForEvent(sourceOf(null), "missing");
    assert.equal(nothing.status, 404);

    const nullEvent = await draftSetForEvent(
        sourceOf({ event: null, songs: [] }),
        "missing",
    );
    assert.equal(nullEvent.status, 404);
});

test("a visible event drafts a set and shapes the full response", async () => {
    const r = await draftSetForEvent(sourceOf(payload()), "ev1");
    assert.equal(r.status, 200);
    if (r.status !== 200) return;

    const body = r.body;
    assert.ok(songsOf(body.set).length >= 2, "expected a multi-song set");
    assert.equal(body.seams.length, songsOf(body.set).length - 1);
    assert.equal(typeof body.sequenceCost, "number");
    assert.ok(body.totalSeconds <= (body.targetSeconds ?? Infinity));
    // This fixture fills 700 of its 900s target, under the 95% bar, so the
    // shortfall is a string that names the lever, not null.
    assert.equal(typeof body.shortfall, "string");
    assert.ok(Array.isArray(body.drops));
});

test("an rpc failure propagates as a thrown error, not a 404", async () => {
    // A null event is 404, but a transport or database failure is a 500-class
    // condition: it must surface, not be masked as a missing event.
    const failing = {
        hydrate: async () => {
            throw new Error("boom");
        },
    };
    await assert.rejects(() => draftSetForEvent(failing, "ev1"), /boom/);
});

test("seamsForOrder honors a per-song transition override (segue) in the clock and the seams", async () => {
    const src = sourceOf(payload());
    const order = ["s1", "s2"]; // s1=180s, s2=200s; padding 30/60

    const base = await seamsForOrder(src, "ev1", order);
    assert.equal(base.status, 200);
    if (base.status !== 200) return;
    // One inter-song gap (30) + the one-time per-set overhead (60), no trailing gap.
    assert.equal(base.body.totalSeconds, 180 + 200 + 30 + 60);

    // A segue (0s) leaving s1 drops that gap from the clock and tightens the seam.
    const segue = await seamsForOrder(src, "ev1", order, [
        { songId: "s1", seconds: 0 },
    ]);
    assert.equal(segue.status, 200);
    if (segue.status !== 200) return;
    assert.equal(segue.body.totalSeconds, 180 + 200 + 0 + 60);
    assert.ok(segue.body.seams[0]!.keyCost > base.body.seams[0]!.keyCost);
});

test("seamsForOrder segments at a break: no across-break seam, break time in the clock", async () => {
    const src = sourceOf(payload());
    const order = ["s1", "s2", "s3"]; // 180/200/170; padding 30/60

    const base = await seamsForOrder(src, "ev1", order);
    assert.equal(base.status, 200);
    if (base.status !== 200) return;
    assert.equal(base.body.seams.length, 2); // 3 songs -> 2 seams
    assert.equal(base.body.totalSeconds, 180 + 200 + 170 + 30 + 30 + 60);

    // A 300s break after s1 splits [s1] | [s2,s3]: the s1->s2 seam is gone, and the
    // break replaces that inter-song gap in the clock.
    const withBreak = await seamsForOrder(
        src,
        "ev1",
        order,
        [],
        [
            {
                id: "b1",
                label: "Intermission",
                durationSeconds: 300,
                afterPosition: 1,
            },
        ],
    );
    assert.equal(withBreak.status, 200);
    if (withBreak.status !== 200) return;
    assert.equal(withBreak.body.seams.length, 1); // only the within-segment s2->s3 seam
    assert.equal(withBreak.body.totalSeconds, 180 + 200 + 170 + 300 + 30 + 60);
});

test("seamsForOrder ignores duplicate ids in the order (R-audit B5)", async () => {
    // A duplicated id would self-seam (s1 -> s1) and double-count its time on the
    // clock. The first occurrence wins; the rest are dropped.
    const src = sourceOf(payload());
    const dup = await seamsForOrder(src, "ev1", ["s1", "s1", "s2"]);
    const clean = await seamsForOrder(src, "ev1", ["s1", "s2"]);
    assert.equal(dup.status, 200);
    assert.equal(clean.status, 200);
    if (dup.status !== 200 || clean.status !== 200) return;
    assert.deepEqual(dup.body, clean.body);
    assert.equal(dup.body.seams.length, 1); // one seam, and it is not s1 -> s1
    assert.equal(dup.body.seams[0]!.fromId, "s1");
    assert.equal(dup.body.seams[0]!.toId, "s2");
});

test("a document with an event but missing pool arrays is rejected, not crashed on (R-audit B6)", async () => {
    // A partial hydration (event present, arrays absent) is a malformed payload,
    // the same invalid-document path as a missing event.
    const eventOnly = await draftSetForEvent(
        sourceOf({ event: payload().event }),
        "ev1",
    );
    assert.equal(eventOnly.status, 404);

    // Any single missing array rejects too.
    for (const key of ["songs", "parts", "castings", "availability"] as const) {
        const partial: Record<string, unknown> = { ...payload() };
        delete partial[key];
        const r = await draftSetForEvent(sourceOf(partial), "ev1");
        assert.equal(r.status, 404, `a payload without ${key} is rejected`);
    }
});

test("the response carries the chase lever, naming who to chase", async () => {
    // m2 covers every Bass part but is only tentative, so every song is blocked
    // at feasibility and chasing m2 would open them.
    const p = payload({
        availability: [
            { memberId: "m1", status: "in" },
            { memberId: "m2", status: "tentative" },
        ],
    });
    const r = await draftSetForEvent(sourceOf(p), "ev1");
    assert.equal(r.status, 200);
    if (r.status !== 200) return;
    assert.ok(r.body.chase.length > 0, "expected chase candidates");
    const target = r.body.chase[0]!.chase[0]!;
    assert.equal(target.memberId, "m2");
    assert.equal(target.displayName, "Nico");
    assert.equal(target.partLabel, "Bass");
});

test("an exclude tag from the hydration drops the song through context", async () => {
    const r = await draftSetForEvent(
        sourceOf(payload({ excludeTags: ["holiday"] })),
        "ev1",
    );
    assert.equal(r.status, 200);
    if (r.status !== 200) return;

    const ids = songsOf(r.body.set).map((e) => e.song.id);
    assert.ok(!ids.includes("s2")); // the holiday-tagged song
    const drop = r.body.drops.find((d) => d.song.id === "s2");
    assert.equal(drop?.stage, "context");
});

test("the endpoint threads a custom sequence config through to the draft", async () => {
    const def = await draftSetForEvent(sourceOf(payload()), "ev1");
    const zero = await draftSetForEvent(sourceOf(payload()), "ev1", {
        ...DEFAULT_SEQUENCE_CONFIG,
        weights: {
            key: 0,
            intensityArc: 0,
            flatline: 0,
            tempo: 0,
            density: 0,
            soloist: 0,
            variety: 0,
        },
    });
    assert.ok(def.status === 200 && zero.status === 200);
    if (def.status !== 200 || zero.status !== 200) return;
    assert.ok(def.body.sequenceCost > 0);
    assert.equal(zero.body.sequenceCost, 0);
});

test("the supabase adapter calls rpc, unwraps data, and throws on error", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ok: SupabaseRpcClient = {
        rpc: (fn, args) => {
            calls.push([fn, args]);
            return Promise.resolve({
                data: { event: { id: "ev1" } },
                error: null,
            });
        },
    };
    const data = await supabaseHydrationSource(ok).hydrate("ev1");
    assert.deepEqual(calls[0], ["hydrate_draft_input", { p_event: "ev1" }]);
    assert.deepEqual(data, { event: { id: "ev1" } });

    // The thrown error is generic (no raw DB text leaks to a caller that might surface it),
    // while the original error is preserved on `cause` for server-side logging.
    const broken: SupabaseRpcClient = {
        rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    };
    await assert.rejects(
        () => supabaseHydrationSource(broken).hydrate("ev1"),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.doesNotMatch(
                err.message,
                /boom/,
                "the raw database message is not in the thrown message",
            );
            assert.match(err.message, /hydration failed/);
            assert.equal(
                (err.cause as { message?: string })?.message,
                "boom",
                "the raw error is kept on cause",
            );
            return true;
        },
    );
});
