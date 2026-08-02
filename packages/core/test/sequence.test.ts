// Run with: npm test
//
// The sequencer: the key transition cost, the position rules on the ends, the
// seam diagnostics, and null handling. This is where the deferred half-step
// clash test from the first slice comes back, now as a real gap-discounted seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    sequence,
    scoreOrder,
    seamsFor,
    keyTransitionCost,
    clockSeconds,
    segmentOrder,
    songsOf,
    draftSet,
    DEFAULT_SEQUENCE_CONFIG,
    type Casting,
    type KeySig,
    type Part,
    type SetBreak,
    type Song,
    type Tag,
} from "../src/index.js";
import {
    members,
    songs,
    parts,
    castings,
    availability,
    event,
    churchContext,
} from "./fixture.js";

function song(
    id: string,
    fifths: number | null,
    tempo: number | null,
    intensity: number | null,
): Song {
    return {
        id,
        title: id,
        startKey: fifths === null ? null : { fifths, mode: "major" },
        endKey: null,
        startTempoBpm: tempo,
        endTempoBpm: null,
        durationSeconds: 180,
        isExplicit: false,
        usesAccompaniment: false,
        intensity,
        tags: [],
        assessedReadiness: "performance-ready",
        bookStatus: "off-book",
        lastPerformed: null,
        lastRehearsed: null,
    };
}

const NO_PARTS = new Map<string, Part[]>();
const NO_CASTS = new Map<string, Casting[]>();
const seq = (
    middle: Song[],
    extra: Partial<Parameters<typeof sequence>[0]> = {},
) =>
    sequence({
        middle,
        partsBySong: NO_PARTS,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 30,
        ...extra,
    });

const C: KeySig = { fifths: 0, mode: "major" };
const G: KeySig = { fifths: 1, mode: "major" };
const Am: KeySig = { fifths: 0, mode: "minor" };
const Fsharp: KeySig = { fifths: 6, mode: "major" };
const Db: KeySig = { fifths: -5, mode: "major" };

test("sanitizeConfig guards densityCap + peakFraction: a degenerate value never NaNs the objective", () => {
    const middle = [
        song("a", 0, 100, 3),
        song("b", 1, 120, 4),
        song("c", 0, 90, 2),
    ];
    // densityCap is a divisor (densitySeam); peakFraction feeds arcCost's Math.round; densityCap 0
    // also 0/0-NaNs on a zero-required-parts song. All three must fall back, not poison the cost.
    for (const bad of [
        { densityCap: NaN },
        { peakFraction: NaN },
        { densityCap: 0 },
    ]) {
        const cfg = { ...DEFAULT_SEQUENCE_CONFIG, ...bad };
        const r = seq(middle, { config: cfg });
        assert.ok(
            Number.isFinite(r.cost),
            `sequence cost stays finite with ${JSON.stringify(bad)} (got ${r.cost})`,
        );
        const rescored = scoreOrder(r.order, {
            partsBySong: NO_PARTS,
            castingsByPart: NO_CASTS,
            perSongGapSeconds: 30,
            config: cfg,
        });
        assert.ok(
            Number.isFinite(rescored),
            `scoreOrder stays finite with ${JSON.stringify(bad)} (got ${rescored})`,
        );
    }
});

test("key transition cost: same, relative, fifth, tritone, and the gap discount", () => {
    assert.equal(keyTransitionCost(C, C, 0), 0); // same tonic
    assert.equal(keyTransitionCost(C, G, 0), 1); // one step on the circle
    assert.equal(keyTransitionCost(C, Am, 0), 0.5); // relative pair, override
    assert.equal(keyTransitionCost(C, Fsharp, 0), 6); // tritone, the worst
    assert.equal(keyTransitionCost(C, Fsharp, 6), 3); // one half-life halves it
    assert.equal(keyTransitionCost(C, null, 0), 0); // a keyless song scores no clash
    assert.ok(keyTransitionCost(C, Db, 0) > keyTransitionCost(C, G, 0)); // Db sits far, G is near
});

test("the order keeps every song exactly once", () => {
    const r = seq([
        song("a", 0, 120, 3),
        song("b", 1, 100, 5),
        song("c", -1, 90, 2),
    ]);
    assert.equal(r.order.length, 3);
    assert.deepEqual(r.order.map((s) => s.id).sort(), ["a", "b", "c"]);
    assert.equal(r.seams.length, 2);
});

test("open and close pins bracket the order", () => {
    const r = seq([song("m1", 1, 100, 3), song("m2", -1, 90, 2)], {
        open: song("o", 0, 120, 4),
        close: song("z", 0, 120, 5),
    });
    assert.equal(r.order[0]!.id, "o");
    assert.equal(r.order[r.order.length - 1]!.id, "z");
    assert.equal(r.order.length, 4);
});

test("the opener is mid-to-high intensity, not the peak or the floor", () => {
    const r = seq([
        song("peak", 0, 120, 5),
        song("mid", 1, 100, 4),
        song("floor", -1, 90, 1),
        song("low", 2, 80, 2),
    ]);
    assert.equal(r.order[0]!.id, "mid"); // intensity 4 beats 5, 2, 1 for opener fit
});

test("the closer is the highest intensity", () => {
    const r = seq([
        song("peak", 0, 120, 5),
        song("mid", 1, 100, 4),
        song("floor", -1, 90, 1),
        song("low", 2, 80, 2),
    ]);
    assert.equal(r.order[r.order.length - 1]!.id, "peak");
});

test("a half-step seam clashes in a medley but is discounted in a concert", () => {
    const pair = [song("c", 0, 120, 3), song("db", -5, 120, 3)];
    const medley = seq(pair, { perSongGapSeconds: 0 });
    assert.ok(medley.seams[0]!.keyCost >= 0.5);
    assert.ok(medley.seams[0]!.flags.includes("harsh-key-change"));

    const concert = seq(pair, { perSongGapSeconds: 45 });
    assert.ok(concert.seams[0]!.keyCost < 0.1);
    assert.ok(!concert.seams[0]!.flags.includes("harsh-key-change"));

    // A tritone is the worst possible seam: full normalized cost in a medley.
    const tritone = seq([song("c2", 0, 120, 3), song("fs", 6, 120, 3)], {
        perSongGapSeconds: 0,
    });
    assert.equal(tritone.seams[0]!.keyCost, 1);
    assert.ok(tritone.seams[0]!.flags.includes("harsh-key-change"));
});

test("a per-song segue override re-intensifies a clash the default gap discounts", () => {
    const pair = [song("c", 0, 120, 3), song("db", -5, 120, 3)];
    // The default 45s gap discounts the half-step clash — no flag.
    assert.ok(
        !seq(pair, { perSongGapSeconds: 45 }).seams[0]!.flags.includes(
            "harsh-key-change",
        ),
    );

    // A segue (0s) LEAVING 'c' re-intensifies the same clash — flagged.
    const segue = seq(pair, {
        perSongGapSeconds: 45,
        transitionOut: new Map([["c", 0]]),
    });
    assert.ok(segue.seams[0]!.keyCost >= 0.5);
    assert.ok(segue.seams[0]!.flags.includes("harsh-key-change"));

    // The override is keyed by the song the gap LEAVES: a segue on the SECOND song
    // ('db') does not touch the c->db seam.
    const wrongEnd = seq(pair, {
        perSongGapSeconds: 45,
        transitionOut: new Map([["db", 0]]),
    });
    assert.ok(!wrongEnd.seams[0]!.flags.includes("harsh-key-change"));
});

test("the clock totals durations + inter-song gaps + per-set overhead; segues reduce it", () => {
    const set = [
        song("a", 0, 120, 3),
        song("b", 1, 120, 3),
        song("c", 2, 120, 3),
    ]; // 180s each
    const padding = { perSongSeconds: 30, perSetSeconds: 60 };
    // 3 songs => 2 inter-song gaps (none after the last) + the one-time per-set overhead.
    assert.equal(clockSeconds(set, padding, new Map()), 180 * 3 + 30 * 2 + 60);
    // A single song: no gap, just duration + per-set overhead (no spurious trailing gap).
    assert.equal(clockSeconds([set[0]!], padding, new Map()), 180 + 60);
    // A segue (0s) leaving 'a' drops that one gap from the clock.
    assert.equal(
        clockSeconds(set, padding, new Map([["a", 0]])),
        180 * 3 + 30 + 60,
    );
    // A break after the 1st song REPLACES that inter-song gap with its own duration.
    const intermission: SetBreak = {
        id: "i",
        label: "Intermission",
        durationSeconds: 300,
        afterPosition: 1,
    };
    assert.equal(
        clockSeconds(set, padding, new Map(), [intermission]),
        180 * 3 + 300 + 30 + 60,
    );
});

test("segmentOrder cuts the order at break ordinals and ignores out-of-range ones", () => {
    const four = [
        song("a", 0, 120, 3),
        song("b", 1, 120, 3),
        song("c", 2, 120, 3),
        song("d", 3, 120, 3),
    ];
    const brk = (afterPosition: number): SetBreak => ({
        id: `b${afterPosition}`,
        label: "I",
        durationSeconds: 60,
        afterPosition,
    });
    assert.deepEqual(
        segmentOrder(four, []).map((s) => s.length),
        [4],
    ); // no break => one segment
    assert.deepEqual(
        segmentOrder(four, [brk(2)]).map((s) => s.length),
        [2, 2],
    );
    assert.deepEqual(
        segmentOrder(four, [brk(1), brk(3)]).map((s) => s.length),
        [1, 2, 1],
    );
    // 0 and >= length never sit between two songs, so they cut nothing.
    assert.deepEqual(
        segmentOrder(four, [brk(0), brk(4), brk(9)]).map((s) => s.length),
        [4],
    );
});

test("a same featured lead back to back is flagged", () => {
    const partsBySong = new Map<string, Part[]>([
        [
            "x1",
            [
                {
                    id: "p1",
                    songId: "x1",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
        [
            "x2",
            [
                {
                    id: "p2",
                    songId: "x2",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
    ]);
    const castingsByPart = new Map<string, Casting[]>([
        [
            "p1",
            [
                {
                    partId: "p1",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
        [
            "p2",
            [
                {
                    partId: "p2",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
    ]);
    const r = sequence({
        middle: [song("x1", 0, 100, 3), song("x2", 0, 100, 3)],
        partsBySong,
        castingsByPart,
        perSongGapSeconds: 30,
    });
    assert.equal(r.seams.length, 1);
    assert.ok(r.seams[0]!.flags.includes("soloist-back-to-back"));
});

test("the soloist seam tracks the available cover, not an absent primary (B6-soloist)", () => {
    // sam is the primary lead on both songs, but each carries a distinct cover. The seam must
    // reflect who actually sings the line: with sam available the two share a lead (clash); with
    // sam out, each falls to its own available cover, so the clash is gone — the sequencer should
    // not flag (or pay for) a back-to-back the audience never hears.
    const partsBySong = new Map<string, Part[]>([
        [
            "x1",
            [
                {
                    id: "p1",
                    songId: "x1",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
        [
            "x2",
            [
                {
                    id: "p2",
                    songId: "x2",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
    ]);
    const castingsByPart = new Map<string, Casting[]>([
        [
            "p1",
            [
                {
                    partId: "p1",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
                {
                    partId: "p1",
                    memberId: "ada",
                    isPrimary: false,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
        [
            "p2",
            [
                {
                    partId: "p2",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
                {
                    partId: "p2",
                    memberId: "cory",
                    isPrimary: false,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
    ]);
    const base = {
        middle: [song("x1", 0, 100, 3), song("x2", 0, 100, 3)],
        partsBySong,
        castingsByPart,
        perSongGapSeconds: 30,
    };

    // Availability-blind, and with the primary available: both lead to sam — a flagged clash.
    assert.ok(sequence(base).seams[0]!.flags.includes("soloist-back-to-back"));
    assert.ok(
        sequence({
            ...base,
            availableMemberIds: new Set(["sam", "ada", "cory"]),
        }).seams[0]!.flags.includes("soloist-back-to-back"),
    );
    // sam is out: each song falls to its own available cover (ada, cory), so the clash clears.
    assert.ok(
        !sequence({
            ...base,
            availableMemberIds: new Set(["ada", "cory"]),
        }).seams[0]!.flags.includes("soloist-back-to-back"),
    );
});

test("missing data is no signal and never crashes", () => {
    const r = seq([song("a", null, null, null), song("b", null, null, null)]);
    assert.equal(r.order.length, 2);
    assert.ok(Number.isFinite(r.cost));
    assert.equal(r.seams[0]!.keyCost, 0);
    assert.ok(!r.seams[0]!.flags.includes("harsh-key-change"));
    assert.ok(!r.seams[0]!.flags.includes("energy-flatline")); // two nulls are not "equal"
});

test("the energy-flatline flag tracks the objective, not just exact ties", () => {
    // flatBandIntensity is 2, so flatlineSeam is 1 at delta 0, 0.5 at delta 1, 0 at
    // delta 2. The flag fires at/above 0.5, matching the term the sequencer minimizes.
    const flag = (ia: number, ib: number) =>
        seq([
            song("a", 0, 100, ia),
            song("b", 0, 100, ib),
        ]).seams[0]!.flags.includes("energy-flatline");
    assert.ok(flag(3, 3)); // identical: flat
    assert.ok(flag(3, 4)); // a near-flat seam the objective penalizes now flags too
    assert.ok(!flag(3, 5)); // a full band apart: not flat
});

test("draftSet returns seam diagnostics and a finite sequence cost", () => {
    const base = { members, songs, parts, castings, availability, event };
    const r = draftSet({ ...base, options: { context: churchContext } });
    assert.equal(r.seams.length, Math.max(0, songsOf(r.set).length - 1));
    assert.ok(Number.isFinite(r.sequenceCost));
    // The church set has a 45s per-song gap, so even an adjacent half-step is a
    // non-issue: no harsh-key flag should survive the discount.
    assert.ok(r.seams.every((s) => !s.flags.includes("harsh-key-change")));
});

test("an unrated song adds no arc signal and is not forced to an end", () => {
    // intensities [4, null, 2, 5]: the rated peak (5) closes, the 4 opens, and the
    // unrated song sits in the body. The arc runs over the rated songs only.
    const r = seq([
        song("a", 0, 120, 4),
        song("n", 1, 100, null),
        song("lo", -1, 90, 2),
        song("hi", 2, 110, 5),
    ]);
    assert.equal(r.order.length, 4);
    assert.equal(r.order[0]!.id, "a"); // intensity 4 beats the null and the 2
    assert.equal(r.order[3]!.id, "hi"); // intensity 5 closes
    assert.ok(r.order.slice(1, 3).some((s) => s.id === "n")); // unrated sits interior
    assert.ok(Number.isFinite(r.cost));
});

test("the cleanup pass is skipped past the interior-size cap, leaving the greedy order (B5)", () => {
    // The same cornered pool the cleanup test improves; a cap below the interior size
    // short-circuits the O(n^3) local search, so the result matches a clean cleanup:false
    // run rather than running the cliff on a runaway pool.
    const pool = [
        song("a", -1, 76, 1),
        song("b", 2, 108, 4),
        song("c", -6, 124, 4),
        song("d", 2, 108, 2),
        song("e", 5, 60, 4),
        song("f", 5, 108, 1),
    ];
    const opts = {
        partsBySong: NO_PARTS,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 0,
    };
    const capped = sequence({
        middle: pool,
        ...opts,
        config: { ...DEFAULT_SEQUENCE_CONFIG, cleanupMaxInteriorSongs: 2 },
    });
    const off = sequence({
        middle: pool,
        ...opts,
        config: { ...DEFAULT_SEQUENCE_CONFIG, cleanup: false },
    });
    assert.deepEqual(
        capped.order.map((s) => s.id),
        off.order.map((s) => s.id),
    );
    assert.equal(capped.cost, off.cost);
});

test("the cleanup pass strictly improves a cornered seed and settles at a local optimum", () => {
    // This pool's greedy seed is not optimal, so the search must actually move a
    // song. That makes the test fail if localSearch ever regressed to a no-op.
    const pool = [
        song("a", -1, 76, 1),
        song("b", 2, 108, 4),
        song("c", -6, 124, 4),
        song("d", 2, 108, 2),
        song("e", 5, 60, 4),
        song("f", 5, 108, 1),
    ];
    const opts = {
        partsBySong: NO_PARTS,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 0,
    };
    const on = sequence({
        middle: pool,
        ...opts,
        config: { ...DEFAULT_SEQUENCE_CONFIG, cleanup: true },
    });
    const off = sequence({
        middle: pool,
        ...opts,
        config: { ...DEFAULT_SEQUENCE_CONFIG, cleanup: false },
    });
    assert.ok(on.cost < off.cost - 1e-9); // real work, not just no harm

    // Settled: with the ends fixed, no interior relocate or swap lowers the cost.
    const order = on.order;
    const base = scoreOrder(order, opts);
    for (let i = 1; i < order.length - 1; i++) {
        for (let j = 1; j < order.length - 1; j++) {
            if (i === j) continue;
            const relocated = order.slice();
            const [x] = relocated.splice(i, 1);
            relocated.splice(j, 0, x!);
            assert.ok(
                scoreOrder(relocated, opts) >= base - 1e-9,
                `relocate ${i}->${j}`,
            );
            const sw = order.slice();
            const tmp = sw[i]!;
            sw[i] = sw[j]!;
            sw[j] = tmp;
            assert.ok(scoreOrder(sw, opts) >= base - 1e-9, `swap ${i}<->${j}`);
        }
    }
});

test("the same lead costs more clustered than spread out", () => {
    const partsBySong = new Map<string, Part[]>([
        [
            "s1",
            [
                {
                    id: "p1",
                    songId: "s1",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
        ["s2", []],
        ["s3", []],
        [
            "s4",
            [
                {
                    id: "p4",
                    songId: "s4",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
    ]);
    const castingsByPart = new Map<string, Casting[]>([
        [
            "p1",
            [
                {
                    partId: "p1",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
        [
            "p4",
            [
                {
                    partId: "p4",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
    ]);
    // All songs share key and tempo and intensity, so the soloist term is the only
    // thing that moves: only the distance between sam's two songs changes.
    const a = song("s1", 0, 100, 3);
    const b = song("s2", 0, 100, 3);
    const c = song("s3", 0, 100, 3);
    const d = song("s4", 0, 100, 3);
    const opts = { partsBySong, castingsByPart, perSongGapSeconds: 30 };
    const adjacent = scoreOrder([a, d, b, c], opts); // sam at 0, 1
    const nearby = scoreOrder([a, b, d, c], opts); //   sam at 0, 2 (recovery window)
    const spread = scoreOrder([a, b, c, d], opts); //   sam at 0, 3 (beyond the window)
    assert.ok(adjacent > nearby);
    assert.ok(nearby > spread);
});

test("density penalizes two walls but not a wall next to a sparse song", () => {
    const dense = (id: string): Part[] => [
        {
            id: `${id}-1`,
            songId: id,
            isRequired: true,
            countNeeded: 4,
            label: "a",
        },
        {
            id: `${id}-2`,
            songId: id,
            isRequired: true,
            countNeeded: 4,
            label: "b",
        },
    ];
    const sparse = (id: string): Part[] => [
        {
            id: `${id}-1`,
            songId: id,
            isRequired: true,
            countNeeded: 1,
            label: "a",
        },
    ];
    const a = song("a", 0, 100, 3);
    const b = song("b", 0, 100, 3);
    const wallToWall = new Map<string, Part[]>([
        ["a", dense("a")],
        ["b", dense("b")],
    ]);
    const wallToSparse = new Map<string, Part[]>([
        ["a", dense("a")],
        ["b", sparse("b")],
    ]);

    const dd = scoreOrder([a, b], {
        partsBySong: wallToWall,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 30,
    });
    const ds = scoreOrder([a, b], {
        partsBySong: wallToSparse,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 30,
    });
    assert.ok(dd > ds); // the product form, so the sparse side pulls the seam down

    const ddSeam = sequence({
        middle: [a, b],
        partsBySong: wallToWall,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 30,
    }).seams[0]!;
    const dsSeam = sequence({
        middle: [a, b],
        partsBySong: wallToSparse,
        castingsByPart: NO_CASTS,
        perSongGapSeconds: 30,
    }).seams[0]!;
    assert.ok(ddSeam.flags.includes("density-wall"));
    assert.ok(!dsSeam.flags.includes("density-wall"));
});

test("empty and single-song pools produce no seams", () => {
    const none = seq([]);
    assert.equal(none.order.length, 0);
    assert.equal(none.seams.length, 0);
    assert.ok(Number.isFinite(none.cost));

    const one = seq([song("a", 0, 120, 3)]);
    assert.equal(one.order.length, 1);
    assert.equal(one.seams.length, 0);
});

const feel =
    (category: "mood" | "groove" | "genre") =>
    (name: string): Tag => ({ name, category });
const tagged = (id: string, tags: Tag[]): Song => ({
    ...song(id, 0, 100, 3),
    tags,
});
const VARIETY_OPTS = {
    partsBySong: NO_PARTS,
    castingsByPart: NO_CASTS,
    perSongGapSeconds: 30,
};

// Each feel category drives variety identically, so test all three: a dropped
// category would otherwise ship green. The songs differ only by tags, so only
// the variety term moves.
for (const category of ["mood", "groove", "genre"] as const) {
    test(`shared ${category} tags make a seam samey and flag it; a different one does not`, () => {
        const t = feel(category);
        const shared = [tagged("a", [t("x")]), tagged("b", [t("x")])];
        const differ = [tagged("a", [t("x")]), tagged("c", [t("y")])];
        assert.ok(
            scoreOrder(shared, VARIETY_OPTS) > scoreOrder(differ, VARIETY_OPTS),
        );
        assert.ok(seq(shared).seams[0]!.flags.includes("same-feel"));
        assert.ok(!seq(differ).seams[0]!.flags.includes("same-feel"));
    });
}

test("a partial feel overlap sits between no overlap and full overlap", () => {
    const g = feel("genre");
    const m = feel("mood");
    const none = [
        tagged("a", [g("rock"), m("happy")]),
        tagged("b", [g("jazz"), m("sad")]),
    ];
    const partial = [
        tagged("a", [g("rock"), m("happy")]),
        tagged("b", [g("rock"), m("sad")]),
    ];
    const full = [
        tagged("a", [g("rock"), m("happy")]),
        tagged("b", [g("rock"), m("happy")]),
    ];
    const cost = (o: Song[]) => scoreOrder(o, VARIETY_OPTS);
    assert.ok(cost(none) < cost(partial)); // Jaccard is graded, not binary
    assert.ok(cost(partial) < cost(full));
});

test("occasion, content, and uncategorized tags carry no adjacency variety", () => {
    const inert: Tag[] = [
        { name: "holiday", category: "occasion" },
        { name: "sacred", category: "content" },
        { name: "misc", category: null },
    ];
    assert.ok(
        !seq([tagged("a", inert), tagged("b", inert)]).seams[0]!.flags.includes(
            "same-feel",
        ),
    );
    // Sharing only non-feel tags costs exactly the same as sharing no tags at all.
    assert.equal(
        scoreOrder([tagged("a", inert), tagged("b", inert)], VARIETY_OPTS),
        scoreOrder([tagged("a", []), tagged("b", [])], VARIETY_OPTS),
    );
});

test("seamsFor agrees with the sequencer and follows a manual reorder", () => {
    const partsBySong = new Map<string, Part[]>([
        [
            "x1",
            [
                {
                    id: "p1",
                    songId: "x1",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
        [
            "x2",
            [
                {
                    id: "p2",
                    songId: "x2",
                    isRequired: true,
                    countNeeded: 1,
                    label: "Solo",
                },
            ],
        ],
    ]);
    const castingsByPart = new Map<string, Casting[]>([
        [
            "p1",
            [
                {
                    partId: "p1",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
        [
            "p2",
            [
                {
                    partId: "p2",
                    memberId: "sam",
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: null,
                },
            ],
        ],
    ]);
    const opts = { partsBySong, castingsByPart, perSongGapSeconds: 30 };

    // For the sequencer's own order, seamsFor returns the very same seams.
    const r = sequence({
        middle: [song("x1", 0, 100, 3), song("x2", 0, 100, 3)],
        ...opts,
    });
    assert.deepEqual(seamsFor(r.order, opts), r.seams);

    // A two-soloist order flags soloist-back-to-back; dropping a third song
    // between them clears it. seamsFor reflects the order it is handed.
    const a = song("x1", 0, 100, 3);
    const b = song("x2", 0, 100, 3);
    const c = song("c", 0, 100, 3); // no parts, no lead
    const optsC = { ...opts };
    assert.ok(
        seamsFor([a, b, c], optsC)[0]!.flags.includes("soloist-back-to-back"),
    );
    assert.ok(
        !seamsFor([a, c, b], optsC)[0]!.flags.includes("soloist-back-to-back"),
    );
});

test("the featured lead has a defined order: smallest part id, then smallest member id (R-audit B1)", () => {
    // The hydration arrays carry no ORDER BY, so "first part" and "first cast" by
    // array position would leak physical row order into the soloist seam. Song a has
    // two single-seat parts (the smallest part id, a-p1, names the featured line, and
    // its two primaries resolve to the smallest member id, m1). Song b has one part
    // with no primary at all, so the smallest member id among the casts (m1) leads.
    // Both resolve to m1, so the seam flags under any array permutation.
    const a = song("a", 0, 120, 3);
    const b = song("b", 1, 100, 4);
    const part = (id: string, songId: string): Part => ({
        id,
        songId,
        label: "Lead",
        isRequired: true,
        countNeeded: 1,
    });
    const cast = (
        partId: string,
        memberId: string,
        isPrimary: boolean,
    ): Casting => ({
        partId,
        memberId,
        isPrimary,
        confidence: "solid",
        directorAssessed: null,
    });

    const run = (partsA: Part[], castsA1: Casting[], castsB: Casting[]) =>
        seamsFor([a, b], {
            partsBySong: new Map([
                ["a", partsA],
                ["b", [part("b-p1", "b")]],
            ]),
            castingsByPart: new Map([
                ["a-p1", castsA1],
                ["a-p2", [cast("a-p2", "m9", true)]],
                ["b-p1", castsB],
            ]),
            perSongGapSeconds: 30,
        });

    const forward = run(
        [part("a-p1", "a"), part("a-p2", "a")],
        [cast("a-p1", "m5", true), cast("a-p1", "m1", true)],
        [cast("b-p1", "m2", false), cast("b-p1", "m1", false)],
    );
    const reversed = run(
        [part("a-p2", "a"), part("a-p1", "a")],
        [cast("a-p1", "m1", true), cast("a-p1", "m5", true)],
        [cast("b-p1", "m1", false), cast("b-p1", "m2", false)],
    );
    assert.ok(
        forward[0]!.flags.includes("soloist-back-to-back"),
        "both songs lead with m1",
    );
    assert.deepEqual(
        reversed,
        forward,
        "permuted parts and castings arrays read the same seams",
    );
});

test("degenerate band and half-life config values fall back to defaults, never NaN (R-audit B3)", () => {
    // flatBandIntensity, tempoBandBpm, and gapHalfLifeSeconds are divisors: at 0 the
    // identical-value seams and a 0-second gap all divide 0/0 and NaN poisons the
    // whole objective. Sanitized values fall back to the defaults instead.
    const degenerate = {
        ...DEFAULT_SEQUENCE_CONFIG,
        flatBandIntensity: 0,
        tempoBandBpm: 0,
        keyCost: { relativeCost: 0.5, gapHalfLifeSeconds: 0 },
    };
    const pair = () => [song("a", 0, 120, 3), song("b", 0, 120, 3)];
    const r = seq(pair(), { perSongGapSeconds: 0, config: degenerate });
    assert.ok(Number.isFinite(r.cost), "the objective stays finite");
    for (const s of r.seams) {
        assert.ok(
            Number.isFinite(s.cost) && Number.isFinite(s.keyCost),
            "every seam cost stays finite",
        );
    }
    // The fallbacks ARE the defaults, so the degenerate config costs the default draft.
    assert.equal(r.cost, seq(pair(), { perSongGapSeconds: 0 }).cost);
});

test("draftSet threads a custom sequence config: zero weights zero the cost", () => {
    const base = { members, songs, parts, castings, availability, event };
    const def = draftSet({ ...base, options: { context: churchContext } });
    const zero = draftSet(
        { ...base, options: { context: churchContext } },
        {
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
        },
    );
    assert.ok(def.sequenceCost > 0);
    assert.equal(zero.sequenceCost, 0);
});
