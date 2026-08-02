// Run with: npm test  (tsx test/drafter.test.ts)
//
// These lock down the behaviour the spec cares about, especially the
// feasibility matching that hand-drafting gets wrong. The half-step key-clash
// test is deferred to the sequencing slice, which owns the seam cost.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    draftSet,
    checkFeasibility,
    checkReadiness,
    songsOf,
    breaksOf,
    DEFAULT_READINESS_FLOOR,
    type Casting,
    type Part,
    type SetItem,
    type Song,
    type Drop,
} from "../src/index.js";
import { renderShortfall } from "../src/drafter/diagnostics.js";
import {
    members,
    songs,
    parts,
    castings,
    availability,
    event,
    churchContext,
} from "./fixture.js";

const base = { members, songs, parts, castings, availability, event };
const titles = (r: { set: SetItem[] }) =>
    songsOf(r.set).map((e) => e.song.title);
const ids = (r: { set: SetItem[] }) => songsOf(r.set).map((e) => e.song.id);

// A bare song that passes the mode and floor filters, for unit tests.
function bareSong(over: Partial<Song> = {}): Song {
    return {
        id: "x",
        title: "Bare",
        startKey: null,
        endKey: null,
        startTempoBpm: null,
        endTempoBpm: null,
        durationSeconds: 120,
        isExplicit: false,
        usesAccompaniment: false,
        intensity: null,
        tags: [],
        assessedReadiness: "performance-ready",
        bookStatus: "off-book",
        lastPerformed: null,
        lastRehearsed: null,
        ...over,
    };
}

test("a missing required part drops the song (VP specialist is out)", () => {
    const r = draftSet({ ...base, options: { context: churchContext } });
    assert.ok(!titles(r).includes("Beatbox Banger"));
    const vpDrop = r.drops.find((d) => d.song.id === "s3");
    assert.equal(vpDrop?.stage, "feasibility");
    assert.match(vpDrop!.detail, /VP/);
});

test("one singer cannot cover two required parts at once", () => {
    // Solo and Bass both required, both single seat, both only coverable by Sam.
    const song = bareSong({ id: "x", title: "Tight Casting" });
    const mkPart = (id: string, label: string): Part => ({
        id,
        songId: "x",
        label,
        isRequired: true,
        countNeeded: 1,
    });
    const mkCast = (partId: string): Casting => ({
        partId,
        memberId: "sam",
        isPrimary: false,
        confidence: "solid",
        directorAssessed: null,
    });

    const songParts = [mkPart("x-solo", "Solo"), mkPart("x-bass", "Bass")];
    const byPart = new Map<string, Casting[]>([
        ["x-solo", [mkCast("x-solo")]],
        ["x-bass", [mkCast("x-bass")]],
    ]);

    const res = checkFeasibility({
        songIndex: { song, parts: songParts },
        castingsByPart: byPart,
        availableMemberIds: new Set(["sam"]),
    });
    assert.equal(res.feasible, false);
    assert.equal(res.shortParts.length, 1); // one of the two seats unfilled
});

test("off-book-only events exclude on-book charts", () => {
    const competition = { ...event, allowsOnBook: false };
    const r = draftSet({
        ...base,
        event: competition,
        options: { context: churchContext },
    });
    assert.ok(!titles(r).includes("On the Book Hymn"));
    const modeDrop = r.drops.find((d) => d.song.id === "s4");
    assert.equal(modeDrop?.stage, "readiness");
    assert.match(modeDrop!.detail, /mode/);
});

test("explicit content is excluded by the native gate", () => {
    const r = draftSet({ ...base, options: { context: churchContext } });
    assert.ok(!titles(r).includes("Explicit Track"));
    const ctxDrop = r.drops.find((d) => d.song.id === "s7");
    assert.equal(ctxDrop?.stage, "context");
    assert.equal(ctxDrop?.detail, "explicit");
});

test("an accompanied chart is excluded at an a-cappella-only event", () => {
    const acc = bareSong({
        id: "acc",
        title: "Backing Track Ballad",
        usesAccompaniment: true,
    });
    const plain = bareSong({ id: "plain", title: "Pure Voices" });
    const args = { parts: [], castings: [], availability: [] };

    // a cappella only: the accompanied chart drops at context, the pure one stays.
    const strict = draftSet({
        songs: [acc, plain],
        event: { ...event, allowsAccompaniment: false },
        ...args,
    });
    assert.ok(titles(strict).includes("Pure Voices"));
    assert.ok(!titles(strict).includes("Backing Track Ballad"));
    const drop = strict.drops.find((d) => d.song.id === "acc");
    assert.equal(drop?.stage, "context");
    assert.equal(drop?.detail, "accompaniment");

    // Default event allows accompaniment, so the same chart is fine.
    const permissive = draftSet({ songs: [acc], event, ...args });
    assert.ok(titles(permissive).includes("Backing Track Ballad"));
});

const requirePolicy = (requireTags: string[]) => ({
    context: { excludeTags: [], preferTags: [], requireTags },
});

test("a required tag forces a carrier into the set, trimming to make room", () => {
    const tagged = bareSong({
        id: "req",
        title: "Original Arrangement",
        tags: [{ name: "original", category: null }],
    });
    const p1 = bareSong({ id: "p1", title: "Filler One" });
    const p2 = bareSong({ id: "p2", title: "Filler Two" });
    // Target fits ~2 of the 120s songs; by score+id the two fillers would fill it and
    // 'req' (id-last) would bench. The mandate must force 'req' in and trim a filler.
    const ev = {
        ...event,
        targetDurationSeconds: 300,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const args = { parts: [], castings: [], availability: [] };

    const plain = draftSet({ songs: [p1, p2, tagged], event: ev, ...args });
    assert.ok(
        !titles(plain).includes("Original Arrangement"),
        "baseline: the tagged song benches without the mandate",
    );

    const r = draftSet({
        songs: [p1, p2, tagged],
        event: ev,
        options: requirePolicy(["original"]),
        ...args,
    });
    assert.ok(
        titles(r).includes("Original Arrangement"),
        "the required-tag song is forced into the set",
    );
    assert.deepEqual(r.requiredMisses, []);
    assert.ok(
        r.totalSeconds <= 300,
        "the set still respects the target after the swap-in",
    );
    assert.ok(
        r.bench.some((e) => e.song.id === "p2"),
        "a filler is trimmed to the bench to make room",
    );
});

test("a required tag no available song carries surfaces in the shortfall", () => {
    const r = draftSet({
        songs: [bareSong({ id: "p1", title: "Filler One" })],
        parts: [],
        castings: [],
        availability: [],
        options: requirePolicy(["gospel-original"]),
        event: {
            ...event,
            targetDurationSeconds: 300,
            padding: { perSongSeconds: 30, perSetSeconds: 0 },
        },
    });
    assert.deepEqual(r.requiredMisses, ["gospel-original"]);
    assert.ok(
        r.shortfall,
        "the unmet mandate forces a shortfall even if the clock is fine",
    );
    assert.match(r.shortfall!, /required tag "gospel-original"/);
});

test("a required tag already represented is a no-op", () => {
    const tagged = bareSong({
        id: "a",
        title: "Already Here",
        tags: [{ name: "original", category: null }],
    });
    const r = draftSet({
        songs: [tagged],
        parts: [],
        castings: [],
        availability: [],
        options: requirePolicy(["original"]),
        event: {
            ...event,
            targetDurationSeconds: 600,
            padding: { perSongSeconds: 30, perSetSeconds: 0 },
        },
    });
    assert.ok(titles(r).includes("Already Here"));
    assert.deepEqual(r.requiredMisses, []);
});

test("a hard cap flags a set that pins push over it", () => {
    // Three 120s songs, all keep-pinned (forced, never trimmed), against a 5-minute cap
    // that fits two. The trim cannot touch forced keeps, so the cap names the lever.
    const songs = ["a", "b", "c"].map((id) =>
        bareSong({ id, title: id.toUpperCase() }),
    );
    const ev = {
        ...event,
        targetDurationSeconds: null,
        maxDurationSeconds: 300,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const r = draftSet({
        songs,
        parts: [],
        castings: [],
        availability: [],
        options: { keep: ["a", "b", "c"] },
        event: ev,
    });
    assert.equal(songsOf(r.set).length, 3, "forced keeps all stay in");
    assert.ok(r.totalSeconds > 300, "the pinned set runs over the cap");
    assert.ok(r.shortfall, "over-cap forces a shortfall");
    assert.match(r.shortfall!, /over the 5-minute cap/);
});

test("with no target, the cap bounds the fill", () => {
    const songs = ["a", "b", "c", "d", "e"].map((id) =>
        bareSong({ id, title: id.toUpperCase() }),
    );
    const ev = {
        ...event,
        targetDurationSeconds: null,
        maxDurationSeconds: 300,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const r = draftSet({
        songs,
        parts: [],
        castings: [],
        availability: [],
        event: ev,
    });
    // Two 120s songs (270s) fit under the 5-minute cap; a third (420s) would not.
    assert.ok(r.totalSeconds <= 300);
    assert.equal(songsOf(r.set).length, 2);
    assert.ok(!r.shortfall, "a set within the cap is not flagged");
});

test("a cap at or above target leaves the fill unchanged", () => {
    const songs = ["a", "b", "c", "d", "e"].map((id) =>
        bareSong({ id, title: id.toUpperCase() }),
    );
    const args = { parts: [], castings: [], availability: [] };
    const base = {
        ...event,
        targetDurationSeconds: 300,
        maxDurationSeconds: null,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const noCap = draftSet({ songs, event: base, ...args });
    const withCap = draftSet({
        songs,
        event: { ...base, maxDurationSeconds: 600 },
        ...args,
    });
    assert.deepEqual(
        songsOf(withCap.set).map((s) => s.song.id),
        songsOf(noCap.set).map((s) => s.song.id),
        "a cap above target does not change which songs are chosen",
    );
    assert.equal(withCap.shortfall, noCap.shortfall);
});

test("a short-notice floor drops needs-polish charts", () => {
    const r = draftSet({
        ...base,
        options: {
            readinessFloor: ["performance-ready"],
            context: churchContext,
        },
    });
    assert.ok(!titles(r).includes("Still Learning This"));
    const drop = r.drops.find((d) => d.song.id === "s6");
    assert.equal(drop?.stage, "readiness");
    assert.match(drop!.detail, /below floor/);
});

test("the set never runs over the target, per-set overhead included", () => {
    const r = draftSet({ ...base, options: { context: churchContext } });
    // totalSeconds is the authoritative running-order clock (durations + inter-song
    // gaps + the one-time per-set overhead), so it must fit the target directly. A
    // regression that dropped the per-set budget reservation would push it over.
    assert.ok(r.totalSeconds <= r.targetSeconds!);
});

test("open and close pins fix the opener and closer", () => {
    const r = draftSet({
        ...base,
        options: { context: churchContext, open: "s5", close: "s2" },
    });
    const setSongs = songsOf(r.set);
    assert.equal(setSongs[0]!.song.id, "s5");
    assert.equal(setSongs[setSongs.length - 1]!.song.id, "s2");
});

test("an underfilled set explains the shortfall and names the lever", () => {
    const r = draftSet({
        ...base,
        options: {
            readinessFloor: ["performance-ready"],
            context: churchContext,
        },
    });
    assert.ok(r.shortfall, "expected a shortfall message");
    assert.match(r.shortfall!, /VP/);
});

test("shortfall feasibility levers sort by impact and cap the tail (D1)", () => {
    // Seven distinct uncovered parts, each a different number of minutes, fed in non-descending
    // order. The rendered levers must lead with the biggest, name at most five, and roll the rest
    // into one line whose minutes and song count reconcile.
    const mkDrop = (detail: string, seconds: number): Drop => ({
        song: bareSong({ id: `s-${detail}` }),
        stage: "feasibility",
        detail,
        stageSeconds: seconds,
    });
    const drops: Drop[] = [
        mkDrop("Alto", 120), // 2 min
        mkDrop("Bass", 1200), // 20 min, the biggest lever
        mkDrop("Tenor", 300), // 5 min
        mkDrop("Soprano", 600), // 10 min
        mkDrop("Lead", 900), // 15 min
        mkDrop("Baritone", 240), // 4 min
        mkDrop("Descant", 180), // 3 min
    ];
    const msg = renderShortfall({
        targetSeconds: 1500,
        filledSeconds: 0,
        drops,
    });

    const rankedMinutes = [...msg.matchAll(/uncovered removes (\d+) min/g)].map(
        (m) => Number(m[1]),
    );
    assert.deepEqual(
        rankedMinutes,
        [20, 15, 10, 5, 4],
        "top five levers, biggest minutes first",
    );
    assert.match(
        msg,
        /Bass uncovered removes 20 min \(1 song\)\./,
        "biggest lever named first",
    );
    // The two smallest (3 min + 2 min, one song each) fold into one reconciling summary line.
    assert.match(msg, /2 more parts uncovered \(5 min, 2 songs\)\./);
});

// --- Added for this slice ---

test("per-set padding reduces the fill budget", () => {
    // Five 100s songs, no per-song gap: without overhead all five fit a 500s target exactly; a
    // 100s per-set overhead is reserved off the top, so only four fit. Deterministic, so it proves
    // the budget reservation directly rather than relying on the fixture pool and the old per-song
    // over-count (which the accurate clock-based fill no longer has).
    const five = Array.from({ length: 5 }, (_, i) =>
        bareSong({ id: `p${i}`, durationSeconds: 100 }),
    );
    const mkInput = (perSetSeconds: number) => ({
        members: [],
        songs: five,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 500,
            padding: { perSongSeconds: 0, perSetSeconds },
        },
    });
    const noOverhead = draftSet(mkInput(0));
    const withOverhead = draftSet(mkInput(100));
    assert.equal(songsOf(noOverhead.set).length, 5);
    assert.equal(songsOf(withOverhead.set).length, 4);
    assert.ok(withOverhead.totalSeconds <= withOverhead.targetSeconds!);
});

test("selection fills to the authoritative clock, not a per-song over-count (B4)", () => {
    // Seven 100s songs with a 50s gap fit a 1000s target exactly on the clock (700 + 6*50). The old
    // fill summed seven gaps (one too many) and stopped at six, returning 850s AND a false shortfall.
    const seven = Array.from({ length: 7 }, (_, i) =>
        bareSong({ id: `q${i}`, durationSeconds: 100 }),
    );
    const r = draftSet({
        members: [],
        songs: seven,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 1000,
            padding: { perSongSeconds: 50, perSetSeconds: 0 },
        },
    });
    assert.equal(songsOf(r.set).length, 7, "all seven fit on the real clock");
    assert.equal(r.totalSeconds, 1000);
    assert.equal(
        r.shortfall,
        null,
        "a set that fills the target raises no shortfall",
    );

    // Long segue overrides are honored by selection, so the set never overruns the target: five
    // songs with 600s outgoing segues cannot all fit a 500s target — only the first does.
    const fiveSeg = Array.from({ length: 5 }, (_, i) =>
        bareSong({ id: `g${i}`, durationSeconds: 100 }),
    );
    const overrides = Object.fromEntries(
        fiveSeg.slice(0, 4).map((s) => [s.id, 600]),
    );
    const r2 = draftSet({
        members: [],
        songs: fiveSeg,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 500,
            padding: { perSongSeconds: 50, perSetSeconds: 0 },
        },
        transitionOut: overrides,
    });
    assert.ok(
        r2.totalSeconds <= 500,
        "a set with long segues still fits the target on the clock",
    );
});

test("a break reserves its time off the budget, so fewer songs fit", () => {
    const noBreak = draftSet({ ...base, options: { context: churchContext } });
    const withBreak = draftSet({
        ...base,
        breaks: [
            {
                id: "b1",
                label: "Intermission",
                durationSeconds: 600,
                afterPosition: 2,
            },
        ],
        options: { context: churchContext },
    });
    assert.ok(
        songsOf(withBreak.set).length < songsOf(noBreak.set).length,
        "a 600s break should crowd out songs",
    );
});

test("a break interleaves at its ordinal slot, gets no seam, and never trails the set", () => {
    const r = draftSet({
        ...base,
        breaks: [
            {
                id: "b1",
                label: "Intermission",
                durationSeconds: 300,
                afterPosition: 1,
            },
        ],
        options: { context: churchContext },
    });
    // afterPosition 1 => the break is the second item, right after the first song.
    assert.equal(r.set[0]!.kind, "song");
    assert.equal(r.set[1]!.kind, "break");
    assert.equal(r.set[r.set.length - 1]!.kind, "song"); // a break never trails the final song
    // One break boundary drops exactly one song-song seam.
    assert.equal(r.seams.length, Math.max(0, songsOf(r.set).length - 1 - 1));
    assert.deepEqual(
        breaksOf(r.set).map((b) => b.label),
        ["Intermission"],
    );
});

test("an out-of-range break ordinal is clamped between two songs, not past the end", () => {
    const r = draftSet({
        ...base,
        breaks: [
            {
                id: "b1",
                label: "Late",
                durationSeconds: 120,
                afterPosition: 999,
            },
        ],
        options: { context: churchContext },
    });
    if (songsOf(r.set).length >= 2) {
        assert.equal(breaksOf(r.set).length, 1);
        assert.equal(r.set[r.set.length - 1]!.kind, "song");
    }
});

test("two breaks at the same slot reserve budget once and render once", () => {
    const one = draftSet({
        ...base,
        breaks: [
            { id: "a", label: "I", durationSeconds: 300, afterPosition: 2 },
        ],
        options: { context: churchContext },
    });
    const two = draftSet({
        ...base,
        breaks: [
            { id: "a", label: "I", durationSeconds: 300, afterPosition: 2 },
            { id: "b", label: "I", durationSeconds: 300, afterPosition: 2 }, // duplicate slot
        ],
        options: { context: churchContext },
    });
    // The duplicate collapses to one break, so the budget reserves once: the same songs fit.
    assert.equal(songsOf(two.set).length, songsOf(one.set).length);
    assert.equal(breaksOf(two.set).length, 1);
    assert.equal(two.totalSeconds, one.totalSeconds);
});

test("an oversized break shrinks the set but still fires the shortfall (not silenced)", () => {
    // A break that consumes most of the budget crowds songs out; the shortfall must reflect
    // the EFFECTIVE break time, not the reserved time, so it is not masked when the break is
    // dropped for too few songs.
    const r = draftSet({
        ...base,
        event: { ...event, targetDurationSeconds: 600 },
        breaks: [
            {
                id: "big",
                label: "Intermission",
                durationSeconds: 540,
                afterPosition: 1,
            },
        ],
        options: { context: churchContext },
    });
    assert.ok(
        r.shortfall,
        "an oversized break must still explain the shortfall",
    );
});

test("a pinned song with no duration is placed but adds no clock time and never masks a shortfall (B6-pinned)", () => {
    // A forced song with an unknown length is still pinned in (pins win the gates), but its
    // missing duration must NOT be silently treated as a real value: it contributes 0 to the
    // authoritative clock — not a guess — so the shortfall stays honest, and every display
    // surface shows "—" for the length rather than "0:00" (SongRow + the sheet page guard on
    // durationSeconds, never on the stage estimate).
    const noLength = bareSong({
        id: "nolen",
        title: "Length Unset",
        durationSeconds: null,
    });
    const r = draftSet({
        members: [],
        songs: [noLength],
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 600,
            padding: { perSongSeconds: 0, perSetSeconds: 0 },
        },
        options: { open: "nolen" },
    });
    assert.ok(
        ids(r).includes("nolen"),
        "the pinned song is placed despite having no duration",
    );
    assert.equal(
        r.totalSeconds,
        0,
        "its unknown length contributes 0 to the clock, not a guessed value",
    );
    assert.ok(
        r.shortfall,
        "the missing time is not silently filled — the shortfall still fires",
    );
});

test("a break shorter than the gap it replaces does not crowd out a fitting song (B4 follow-up)", () => {
    // 7 songs (dur 100, gap 50) + a 10s break: the clock is 700 + 5*50 + 10 = 960 <= 1000, so all
    // seven fit. The old budget reserved the FULL break AND still charged the gap it replaces, so it
    // double-charged and stranded the 7th. The budget now reserves only the net break cost.
    const seven = Array.from({ length: 7 }, (_, i) =>
        bareSong({ id: `b${i}`, durationSeconds: 100 }),
    );
    const r = draftSet({
        members: [],
        songs: seven,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 1000,
            padding: { perSongSeconds: 50, perSetSeconds: 0 },
        },
        breaks: [
            {
                id: "i",
                label: "Intermission",
                durationSeconds: 10,
                afterPosition: 3,
            },
        ],
    });
    assert.equal(songsOf(r.set).length, 7, "all seven fit (960 <= 1000)");
    assert.ok(r.totalSeconds <= 1000);
});

test("a long segue never makes the produced set overrun the target (B4 follow-up)", () => {
    // Selection admits on the BEST order (the long-segue song last), which fills more than the old
    // drop-smallest bound; the post-sequence trim then removes the lowest-score song until the
    // produced clock fits, so the set never overruns regardless of where the sequencer puts the segue.
    const songs = [
        bareSong({ id: "fat", durationSeconds: 180, intensity: 5 }),
        ...Array.from({ length: 12 }, (_, i) =>
            bareSong({ id: `n${i}`, durationSeconds: 180, intensity: 3 }),
        ),
    ];
    const r = draftSet({
        members: [],
        songs,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 1800,
            padding: { perSongSeconds: 30, perSetSeconds: 0 },
        },
        transitionOut: { fat: 600 },
    });
    assert.ok(
        r.totalSeconds <= 1800,
        "the produced set fits the target on the authoritative clock",
    );
});

test("the sequenced pool is capped so a huge no-target pool cannot pin the CPU (#6e)", () => {
    // With no target, selection returns every qualified song; the sequencer's greedy order is O(n^2),
    // so an unbounded pool would burn CPU. The set is capped to the best-scoring MAX_SEQUENCE_SONGS
    // (256); the overflow falls to the bench, never the void.
    const many = Array.from({ length: 600 }, (_, i) =>
        bareSong({ id: `m${i}`, durationSeconds: 120 }),
    );
    const r = draftSet({
        members: [],
        songs: many,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: null,
            padding: { perSongSeconds: 0, perSetSeconds: 0 },
        },
    });
    assert.ok(
        songsOf(r.set).length <= 256,
        "the set is capped to the sequence bound",
    );
    assert.equal(
        songsOf(r.set).length + r.bench.length,
        600,
        "every qualified song is either set or benched",
    );
    assert.ok(r.bench.length >= 600 - 256, "the overflow falls to the bench");
});

test("the shortfall verdict never diverges from the authoritative clock (B6)", () => {
    // The verdict must read totalSeconds (the wall clock), not the selection-stage sum: that
    // sum charges a per-song gap after every song (one too many) and adds break time on top of
    // those gaps, so the two could disagree and a shortfall the displayed total contradicts
    // would fire (or be masked). Across full-fill, underfill, pinned-ends, and break scenarios,
    // a shortfall fires exactly when the clock falls below 95% of the target (FILL_THRESHOLD).
    const scenarios: Parameters<typeof draftSet>[0][] = [
        { ...base, options: { context: churchContext } },
        {
            ...base,
            options: {
                readinessFloor: ["performance-ready"],
                context: churchContext,
            },
        },
        {
            ...base,
            options: { context: churchContext, open: "s5", close: "s2" },
        },
        {
            ...base,
            breaks: [
                {
                    id: "b",
                    label: "Intermission",
                    durationSeconds: 600,
                    afterPosition: 2,
                },
            ],
            options: { context: churchContext },
        },
    ];
    for (const input of scenarios) {
        const r = draftSet(input);
        const belowThreshold = r.totalSeconds < r.targetSeconds! * 0.95;
        assert.equal(
            r.shortfall !== null,
            belowThreshold,
            `shortfall=${r.shortfall !== null} but clock is ${r.totalSeconds}/${r.targetSeconds}`,
        );
    }
});

test("a pinned opener and closer survive a mid-set break", () => {
    const r = draftSet({
        ...base,
        breaks: [
            {
                id: "i",
                label: "Intermission",
                durationSeconds: 120,
                afterPosition: 2,
            },
        ],
        options: { context: churchContext, open: "s5", close: "s2" },
    });
    const setSongs = songsOf(r.set);
    assert.equal(setSongs[0]!.song.id, "s5"); // opener first, ahead of the break
    assert.equal(setSongs[setSongs.length - 1]!.song.id, "s2"); // closer last, after the break
    assert.equal(breaksOf(r.set).length, 1);
});

test("the explicit gate drops a song and the shortfall names it", () => {
    const r = draftSet({
        ...base,
        options: {
            readinessFloor: ["performance-ready"],
            context: churchContext,
        },
    });
    assert.ok(
        r.drops.some((d) => d.song.id === "s7" && d.detail === "explicit"),
    );
    assert.ok(r.shortfall, "expected a shortfall message");
    assert.match(r.shortfall!, /explicit/);
});

test("keep forces a song into the body, not pinned to an end", () => {
    // s3 is infeasible (VP out), so it would normally drop. keep overrides the
    // gates and routes it through the body between the pinned ends. The sequencer
    // (a later slice) is what makes the position truly flexible; here we prove the
    // kept song lands in the interior and shares it with selected songs.
    const r = draftSet({
        ...base,
        options: {
            context: churchContext,
            open: "s1",
            close: "s2",
            keep: ["s3"],
        },
    });
    const setSongs = songsOf(r.set);
    assert.equal(setSongs[0]!.song.id, "s1");
    assert.equal(setSongs[setSongs.length - 1]!.song.id, "s2");
    const order = ids(r);
    assert.ok(order.includes("s3")); // forced in despite VP infeasibility
    const interior = order.slice(1, -1);
    assert.ok(
        interior.includes("s3"),
        "keep is not pinned to an opener or closer slot",
    );
    assert.ok(
        interior.some((id) => id !== "s3"),
        "keep shares the body with selected songs",
    );
});

test("a duplicated keep id is placed once, not double-counted", () => {
    const once = draftSet({
        ...base,
        options: { context: churchContext, keep: ["s3"] },
    });
    const twice = draftSet({
        ...base,
        options: { context: churchContext, keep: ["s3", "s3"] },
    });
    assert.equal(ids(twice).filter((id) => id === "s3").length, 1);
    assert.deepEqual(ids(twice), ids(once)); // budget not burned twice
    assert.equal(twice.totalSeconds, once.totalSeconds);
});

test("a song pinned to both ends is placed once, at the start", () => {
    const r = draftSet({
        ...base,
        options: { context: churchContext, open: "s1", close: "s1" },
    });
    assert.equal(ids(r).filter((id) => id === "s1").length, 1);
    assert.equal(songsOf(r.set)[0]!.song.id, "s1");
});

test("the bench holds ready songs that did not fit, and never the chosen ones", () => {
    // A tight target leaves ready, coverable songs on the bench. They are disjoint
    // from the set, and gate-failed songs (VP out, explicit, on-book) are not here:
    // the bench is only the songs that qualified but lost on length.
    const tight = { ...event, targetDurationSeconds: 240 };
    const r = draftSet({
        ...base,
        event: tight,
        options: { context: churchContext },
    });

    const setIds = new Set(ids(r));
    const benchIds = r.bench.map((e) => e.song.id);
    assert.ok(
        r.bench.length > 0,
        "expected songs left on the bench under a tight target",
    );
    assert.ok(
        benchIds.every((id) => !setIds.has(id)),
        "bench is disjoint from the set",
    );
    // s3 (VP out, feasibility), s7 (explicit), s4 (on-book) failed gates, never benched.
    for (const dropped of ["s3", "s7"]) {
        assert.ok(
            !benchIds.includes(dropped),
            `${dropped} failed a gate, so it is a drop not a bench song`,
        );
    }
    // Sorted best-first: scores are non-increasing down the bench.
    const stages = r.bench.map((e) => e.stage);
    assert.ok(
        stages.every((s) => s > 0),
        "benched songs carry a padded stage time",
    );
});

test("variety reshuffles selection by seed, reproducibly, and only when amount > 0", () => {
    // Six equally-scored ready songs (no parts, so trivially feasible), a target
    // that fits three. The deterministic draft picks the same three every time.
    const pool = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id) =>
        bareSong({ id, title: id, durationSeconds: 150 }),
    );
    const vEvent = {
        id: "e",
        eventDate: null,
        targetDurationSeconds: 540,
        maxDurationSeconds: null,
        allowsOnBook: true,
        allowsExplicit: false,
        allowsAccompaniment: true,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const run = (variety?: { seed: number; amount: number }) =>
        draftSet({
            songs: pool,
            parts: [],
            castings: [],
            availability: [],
            event: vEvent,
            options: variety ? { variety } : {},
        });
    const setIds = (r: ReturnType<typeof run>) =>
        songsOf(r.set)
            .map((e) => e.song.id)
            .sort();

    const base = setIds(run());
    assert.equal(base.length, 3, "a tight target picks three of six");

    // amount 0 is a no-op: identical to the deterministic draft.
    assert.deepEqual(setIds(run({ seed: 99, amount: 0 })), base);

    // A given seed reproduces its set.
    assert.deepEqual(
        setIds(run({ seed: 7, amount: 5 })),
        setIds(run({ seed: 7, amount: 5 })),
    );

    // Some seed pulls a different set than the deterministic one.
    const differs = Array.from({ length: 25 }, (_, i) => i).some(
        (seed) =>
            JSON.stringify(setIds(run({ seed, amount: 5 }))) !==
            JSON.stringify(base),
    );
    assert.ok(differs, "with variety on, some seed pulls a different set");
});

test("a sub-gap break at the EXACT target boundary does not strand a fitting song (R4 #2a)", () => {
    // 7 songs (dur 100, gap 50) + a 10s break: clock = 700 + 5*50 + 10 = 960 == target, so all seven
    // fit exactly. The B4 follow-up test above uses target 1000 (slack), so it never exercised the
    // boundary; here the clamp on the break's net cost (max(0, 10-50)=0) discarded the 40s the short
    // break gives back and stranded the 7th. The signed net + add-back reconciliation admit all seven.
    const seven = Array.from({ length: 7 }, (_, i) =>
        bareSong({ id: `x${i}`, durationSeconds: 100 }),
    );
    const r = draftSet({
        members: [],
        songs: seven,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 960,
            padding: { perSongSeconds: 50, perSetSeconds: 0 },
        },
        breaks: [
            {
                id: "i",
                label: "Intermission",
                durationSeconds: 10,
                afterPosition: 3,
            },
        ],
    });
    assert.equal(
        songsOf(r.set).length,
        7,
        "all seven fit exactly (700 + 5*50 + 10 = 960)",
    );
    assert.equal(r.totalSeconds, 960);
    assert.equal(
        r.shortfall,
        null,
        "an exactly-filled set raises no shortfall",
    );
});

test("two breaks whose ordinals normalize onto one slot do not double-reserve budget (R4 #2b)", () => {
    // afterPosition 100 and 101 both clamp into [1, n-1] and MERGE to one break; the selection budget
    // deduped them by raw slot and reserved two, under-filling. The add-back reconciliation restores
    // the song the discarded second reservation had stranded: nine fit (900 + one 100s break = 1000).
    const ten = Array.from({ length: 10 }, (_, i) =>
        bareSong({ id: `t${i}`, durationSeconds: 100 }),
    );
    const r = draftSet({
        members: [],
        songs: ten,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 1000,
            padding: { perSongSeconds: 0, perSetSeconds: 0 },
        },
        breaks: [
            { id: "a", label: "I", durationSeconds: 100, afterPosition: 100 },
            { id: "b", label: "I", durationSeconds: 100, afterPosition: 101 },
        ],
    });
    assert.equal(
        breaksOf(r.set).length,
        1,
        "the two out-of-range breaks normalize to one",
    );
    assert.equal(
        songsOf(r.set).length,
        9,
        "nine fit (900 + 100 break = 1000), not eight",
    );
    assert.ok(r.totalSeconds <= 1000);
});

test("forced keeps beyond the sequencer cap surface as capacity drops, never vanish (R4 #1)", () => {
    // 300 explicit pins against a 256-song sequencer cap: the overflow used to be sliced off and lost
    // from the set, the bench, AND the drops. It must now appear as capacity drops so a director's
    // pin is never silently violated.
    const pins = Array.from({ length: 300 }, (_, i) => `k${i}`);
    const many = pins.map((id) => bareSong({ id, durationSeconds: 100 }));
    const r = draftSet({
        members: [],
        songs: many,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: null,
            padding: { perSongSeconds: 0, perSetSeconds: 0 },
        },
        options: { keep: pins },
    });
    const setIds = new Set(ids(r));
    assert.ok(setIds.size <= 256, "the set is capped to the sequencer bound");
    const capDrops = r.drops.filter((d) => d.stage === "capacity");
    assert.equal(
        capDrops.length,
        300 - setIds.size,
        "every over-cap pin becomes a capacity drop",
    );
    const dropIds = new Set(r.drops.map((d) => d.song.id));
    for (const id of pins) {
        assert.ok(
            setIds.has(id) || dropIds.has(id),
            `pin ${id} must not vanish from set and drops`,
        );
    }
});

test("per-set overhead exceeding the target reports an invalid config, not a silent empty set (R4 #7)", () => {
    // target 100 but 600s of per-set overhead: no song can fit (fill budget is negative), and the
    // overhead-only clock (600) sits ABOVE the target, which used to suppress the fill-threshold
    // shortfall — a quiet empty set with no signal. Now the impossible config is named explicitly.
    const r = draftSet({
        members: [],
        songs: [bareSong({ id: "one", durationSeconds: 100 })],
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 100,
            padding: { perSongSeconds: 45, perSetSeconds: 600 },
        },
    });
    assert.equal(
        songsOf(r.set).length,
        0,
        "no song fits when the overhead meets/exceeds the target",
    );
    assert.ok(
        r.shortfall,
        "the impossible configuration is surfaced, not a silent empty set",
    );
    assert.match(r.shortfall!, /overhead/i);
});

test("the draft is independent of input array order under score ties (R-audit B1)", () => {
    // Six identical songs (equal scores everywhere) with a target that fits three:
    // pure tie-break territory. The hydration provides no ORDER BY, so without a
    // deterministic tie-break the physical row order decided the set, the bench,
    // and the sequence. Permuting songs, parts, AND castings must not change any
    // part of the result.
    const ids6 = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const pool = ids6.map((id) =>
        bareSong({ id, title: id, durationSeconds: 150 }),
    );
    const poolParts: Part[] = pool.map((s) => ({
        id: `${s.id}-lead`,
        songId: s.id,
        label: "Lead",
        isRequired: true,
        countNeeded: 1,
    }));
    const poolCasts: Casting[] = pool.flatMap((s) => [
        {
            partId: `${s.id}-lead`,
            memberId: "m1",
            isPrimary: true,
            confidence: "solid" as const,
            directorAssessed: null,
        },
        {
            partId: `${s.id}-lead`,
            memberId: "m2",
            isPrimary: false,
            confidence: "solid" as const,
            directorAssessed: null,
        },
    ]);
    const avail = [
        { memberId: "m1", status: "in" as const },
        { memberId: "m2", status: "in" as const },
    ];
    const ev = {
        ...event,
        targetDurationSeconds: 540,
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };

    const fingerprint = (
        songsArr: Song[],
        partsArr: Part[],
        castsArr: Casting[],
    ): string => {
        const r = draftSet({
            songs: songsArr,
            parts: partsArr,
            castings: castsArr,
            availability: avail,
            event: ev,
        });
        return JSON.stringify({
            set: ids(r),
            bench: r.bench.map((e) => e.song.id),
            drops: r.drops.map((d) => [d.song.id, d.stage]).sort(),
            seams: r.seams.map((s) => [s.fromId, s.toId]),
            total: r.totalSeconds,
        });
    };
    // A fixed shuffle of a six-element array, so the run is reproducible.
    const shuffle = <T>(arr: T[]): T[] =>
        [3, 0, 5, 2, 4, 1].map((i) => arr[i]!);

    const base = fingerprint(pool, poolParts, poolCasts);
    const reversed = fingerprint(
        [...pool].reverse(),
        [...poolParts].reverse(),
        [...poolCasts].reverse(),
    );
    const shuffled = fingerprint(
        shuffle(pool),
        shuffle(poolParts),
        [...poolCasts].reverse(),
    );
    assert.equal(
        reversed,
        base,
        "reversed input arrays must draft the identical result",
    );
    assert.equal(
        shuffled,
        base,
        "shuffled input arrays must draft the identical result",
    );
});

test("a forced id missing from the pool surfaces instead of vanishing (R-audit B2)", () => {
    // A pinned song archived after the lock was set: hydrate filters status=active,
    // so the id reaches the drafter with no Song row behind it. It cannot be drafted
    // (and there is no Song to report as a drop), but it must not vanish silently.
    const r = draftSet({
        ...base,
        options: {
            context: churchContext,
            open: "ghost-open",
            keep: ["ghost-id"],
        },
    });
    assert.deepEqual(r.unknownForcedIds, ["ghost-open", "ghost-id"]);
    assert.ok(!ids(r).includes("ghost-id"));
    assert.ok(!r.bench.some((e) => e.song.id === "ghost-id"));

    // A stale pin costs nothing: the rest of the draft matches the unpinned one,
    // and a clean draft reports no unknown ids.
    const plain = draftSet({ ...base, options: { context: churchContext } });
    assert.deepEqual(ids(r), ids(plain));
    assert.deepEqual(plain.unknownForcedIds, []);
});

test("a NaN variety amount is treated as no variety, not a NaN draft (R-audit B3)", () => {
    const plain = draftSet({ ...base, options: { context: churchContext } });
    const nan = draftSet({
        ...base,
        options: { context: churchContext, variety: { seed: 7, amount: NaN } },
    });
    assert.deepEqual(
        ids(nan),
        ids(plain),
        "a NaN amount draws the deterministic draft",
    );
    assert.equal(nan.totalSeconds, plain.totalSeconds);
    assert.ok(Number.isFinite(nan.sequenceCost));
});

test("qualified songs with no duration surface as a data lever in the shortfall (R-audit B4)", () => {
    // Both songs clear every gate but carry no chart length, so nothing can be
    // length-placed and the set is empty. The shortfall must name the missing
    // durations, not leave the underfill unexplained.
    const pool = ["u1", "u2"].map((id) =>
        bareSong({ id, title: id, durationSeconds: null }),
    );
    const r = draftSet({
        songs: pool,
        parts: [],
        castings: [],
        availability: [],
        event: {
            ...event,
            targetDurationSeconds: 600,
            padding: { perSongSeconds: 0, perSetSeconds: 0 },
        },
    });
    assert.equal(songsOf(r.set).length, 0);
    assert.equal(r.drops.filter((d) => d.stage === "data").length, 2);
    assert.ok(r.shortfall, "the empty set explains itself");
    assert.match(r.shortfall!, /duration/i);
    assert.match(r.shortfall!, /2 songs/);
});

test("null confidence carries no penalty, distinct from shaky", () => {
    const song = bareSong();
    const part: Part = {
        id: "p",
        songId: "x",
        label: "Solo",
        isRequired: true,
        countNeeded: 1,
    };
    const read = (confidence: Casting["confidence"]) =>
        checkReadiness({
            song,
            parts: [part],
            castingsByPart: new Map<string, Casting[]>([
                [
                    "p",
                    [
                        {
                            partId: "p",
                            memberId: "m",
                            isPrimary: true,
                            confidence,
                            directorAssessed: null,
                        },
                    ],
                ],
            ]),
            availableMemberIds: new Set(["m"]),
            event,
            readinessFloor: DEFAULT_READINESS_FLOOR,
        });

    assert.equal(read(null).soloConfidencePenalty, 0);
    assert.equal(read("solid").soloConfidencePenalty, 0);
    assert.equal(read("shaky").soloConfidencePenalty, 1);
});

test("the director read wins over the self-report in the readiness penalty", () => {
    const song = bareSong();
    const part: Part = {
        id: "p",
        songId: "x",
        label: "Solo",
        isRequired: true,
        countNeeded: 1,
    };
    const penalty = (
        confidence: Casting["confidence"],
        directorAssessed: Casting["directorAssessed"],
    ) =>
        checkReadiness({
            song,
            parts: [part],
            castingsByPart: new Map<string, Casting[]>([
                [
                    "p",
                    [
                        {
                            partId: "p",
                            memberId: "m",
                            isPrimary: true,
                            confidence,
                            directorAssessed,
                        },
                    ],
                ],
            ]),
            availableMemberIds: new Set(["m"]),
            event,
            readinessFloor: DEFAULT_READINESS_FLOOR,
        }).soloConfidencePenalty;

    // The director's own read wins over the self-report, both directions.
    assert.equal(
        penalty("shaky", "solid"),
        0,
        "a solid director read clears a shaky self-report",
    );
    assert.equal(
        penalty("solid", "shaky"),
        1,
        "a shaky director read overrides a solid self-report",
    );
    // No director read falls back to the self-report.
    assert.equal(
        penalty("shaky", null),
        1,
        "no director read falls back to the self-report",
    );
    // The director read applies even when the member never self-reported.
    assert.equal(
        penalty(null, "learning"),
        2,
        "a director read applies with no self-report",
    );
});

test("a song gone cold sorts under a fresh one and is flagged on the bench", () => {
    // Two ready, coverable songs, identical but for the last rehearsal. Only one fits
    // the target, so selection must choose: the fresh one wins, the cold one benches.
    const fresh = bareSong({
        id: "fresh",
        title: "Fresh",
        lastRehearsed: "2026-06-01",
    });
    const cold = bareSong({
        id: "cold",
        title: "Cold",
        lastRehearsed: "2026-01-01",
    }); // 178 days out
    const ev = {
        ...event,
        eventDate: "2026-06-28",
        targetDurationSeconds: 200, // one ~120s song fits, not two
        padding: { perSongSeconds: 30, perSetSeconds: 0 },
    };
    const r = draftSet({
        songs: [cold, fresh],
        parts: [],
        castings: [],
        availability: [],
        event: ev,
    });

    // The fresh song takes the single slot; staleness is a nudge, so the cold song is
    // benched, not gated.
    assert.deepEqual(
        songsOf(r.set).map((i) => i.song.id),
        ["fresh"],
    );
    const benched = r.bench.find((e) => e.song.id === "cold");
    assert.ok(benched, "the cold song is on the bench");
    assert.equal(
        benched!.stale,
        true,
        "the benched cold song is flagged gone cold",
    );

    // With room for both, the cold song still makes the set (the nudge never excludes).
    const roomy = draftSet({
        songs: [cold, fresh],
        parts: [],
        castings: [],
        availability: [],
        event: { ...ev, targetDurationSeconds: 600 },
    });
    assert.equal(
        songsOf(roomy.set).length,
        2,
        "a gentle nudge never gates the cold song out",
    );
});
