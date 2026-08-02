// Run with: npm test  (tsx test/prefer.test.ts)
//
// "Prefer, don't force." A preferred song (the director's prep commitment) bypasses the soft
// gates (readiness, context) like a keep, but stays feasibility- and budget-gated: an
// uncastable or over-budget commitment benches instead of forcing the set short a part or long
// on the clock. Preferred songs fill ahead of the rest, most-ready first.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    draftSet,
    songsOf,
    type Availability,
    type DraftOptions,
    type Song,
} from "../src/index.js";
import {
    members,
    songs,
    parts,
    castings,
    availability,
    event,
} from "./fixture.js";

const base = { members, songs, parts, castings, availability, event };
const benchIds = (r: { bench: { song: { id: string } }[] }) =>
    r.bench.map((b) => b.song.id);
const dropStage = (
    r: { drops: { song: { id: string }; stage: string }[] },
    id: string,
) => r.drops.find((d) => d.song.id === id)?.stage;

// A part-free song, so it is trivially castable — feasibility never gates it, letting the
// readiness/context/budget behaviour stand on its own.
function song(
    id: string,
    readiness: Song["assessedReadiness"],
    durationSeconds = 200,
): Song {
    return {
        id,
        title: id.toUpperCase(),
        startKey: null,
        endKey: null,
        startTempoBpm: null,
        endTempoBpm: null,
        durationSeconds,
        isExplicit: false,
        usesAccompaniment: false,
        intensity: null,
        tags: [],
        assessedReadiness: readiness,
        bookStatus: "off-book",
        lastPerformed: null,
        lastRehearsed: null,
    };
}

const allIn: Availability[] = members.map((m) => ({
    memberId: m.id,
    status: "in",
}));

// Draft a bare song list against an all-present roster with a chosen target, no parts.
function draft(
    songList: Song[],
    target: number | null,
    options: DraftOptions = {},
) {
    return draftSet({
        members,
        songs: songList,
        parts: [],
        castings: [],
        availability: allIn,
        event: {
            ...event,
            targetDurationSeconds: target,
            maxDurationSeconds: null,
        },
        options,
    });
}

test("a preferred song overrides the readiness floor", () => {
    const pool = [song("dormant", "dormant")];
    // Without prefer, a dormant song is below the floor and drops at readiness.
    const plain = draft(pool, 2000);
    assert.equal(dropStage(plain, "dormant"), "readiness");
    assert.ok(!songsOf(plain.set).some((e) => e.song.id === "dormant"));
    // Preferred, the same song bypasses the floor and lands in the set.
    const preferred = draft(pool, 2000, { prefer: ["dormant"] });
    assert.ok(songsOf(preferred.set).some((e) => e.song.id === "dormant"));
    assert.equal(dropStage(preferred, "dormant"), undefined);
});

test("a preferred song still respects feasibility (an uncastable commitment benches)", () => {
    // s3 needs a VP part only Victor covers, and Victor is out for this event.
    const preferred = draftSet({ ...base, options: { prefer: ["s3"] } });
    assert.ok(!songsOf(preferred.set).some((e) => e.song.id === "s3"));
    assert.equal(dropStage(preferred, "s3"), "feasibility");
    // Contrast: a hard keep forces it in past feasibility (the existing pin behaviour).
    const kept = draftSet({ ...base, options: { keep: ["s3"] } });
    assert.ok(songsOf(kept.set).some((e) => e.song.id === "s3"));
});

test("a preferred song overrides the context gate (explicit at a no-explicit event)", () => {
    // s7 is explicit; the church event disallows explicit, so it drops at context normally.
    const plain = draftSet(base);
    assert.equal(dropStage(plain, "s7"), "context");
    // Preferred, it is no longer gated at context (it makes the set or the bench, not the drops).
    const preferred = draftSet({ ...base, options: { prefer: ["s7"] } });
    assert.equal(dropStage(preferred, "s7"), undefined);
});

test("preferred songs respect the budget: the overflow benches, the set never runs over", () => {
    const pool = [
        song("p1", "performance-ready"),
        song("p2", "performance-ready"),
        song("p3", "performance-ready"),
    ];
    const opts: DraftOptions = { prefer: ["p1", "p2", "p3"] };
    // A generous target holds all three (proves it is the budget, not a gate, that benches below).
    const roomy = draft(pool, 2000, opts);
    assert.equal(songsOf(roomy.set).length, 3);
    // A tight target holds two; the third benches rather than forcing the set over.
    const tight = draft(pool, 600, opts);
    assert.equal(songsOf(tight.set).length, 2);
    assert.equal(tight.bench.length, 1);
    assert.ok(tight.totalSeconds <= 600);
});

test("within the preferred tier, the most-ready fills first under a tight budget", () => {
    const pool = [
        song("ready", "performance-ready", 300),
        song("cold", "dormant", 300),
    ];
    // Target holds one song; both are preferred, so the readier of the two wins the slot.
    const r = draft(pool, 500, { prefer: ["ready", "cold"] });
    assert.deepEqual(
        songsOf(r.set).map((e) => e.song.id),
        ["ready"],
    );
    assert.deepEqual(benchIds(r), ["cold"]);
});

test("a preferred song outranks a higher-scored non-preferred one for a scarce slot", () => {
    // The non-preferred song is performance-ready (higher score); the preferred one is only
    // learning. The budget holds one, and the preferred song still wins.
    const pool = [
        song("prep", "learning", 300),
        song("shiny", "performance-ready", 300),
    ];
    const r = draft(pool, 500, { prefer: ["prep"] });
    assert.deepEqual(
        songsOf(r.set).map((e) => e.song.id),
        ["prep"],
    );
    assert.deepEqual(benchIds(r), ["shiny"]);
});

test("an explicit exclude wins over prefer", () => {
    const pool = [
        song("a", "performance-ready"),
        song("b", "performance-ready"),
    ];
    const r = draft(pool, 2000, { prefer: ["a", "b"], excluded: ["a"] });
    const ids = songsOf(r.set).map((e) => e.song.id);
    assert.ok(!ids.includes("a"));
    assert.ok(ids.includes("b"));
});

test("a slot reclaimed by break under-fill goes to a benched preferred song, not a higher-scored one", () => {
    // Two breaks at distinct out-of-range slots each reserve budget, but the real clock clamps both
    // onto one slot and charges it once. So the pre-sequence budget over-reserves: selection first
    // admits only pa and benches both p and m. When the reconcile-up loop reclaims the slot, it must
    // hand it to the preferred (prep) song p, even though the non-preferred m scores higher.
    const r = draftSet({
        members,
        songs: [
            song("pa", "performance-ready", 200),
            song("p", "learning", 200),
            song("m", "performance-ready", 200),
        ],
        parts: [],
        castings: [],
        availability: allIn,
        event: {
            ...event,
            targetDurationSeconds: 980,
            maxDurationSeconds: null,
        },
        options: { prefer: ["pa", "p"] },
        breaks: [
            {
                id: "b1",
                label: "Break",
                durationSeconds: 300,
                afterPosition: 5,
            },
            {
                id: "b2",
                label: "Break",
                durationSeconds: 300,
                afterPosition: 6,
            },
        ],
    });
    const ids = songsOf(r.set).map((e) => e.song.id);
    assert.ok(
        ids.includes("p"),
        "the benched preferred song reclaims the slot",
    );
    assert.ok(
        !ids.includes("m"),
        "the higher-scored non-preferred song does not take it",
    );
});
