// Run with: npm test  (tsx test/casting.test.ts)
//
// The range-aware casting suggestion. It never gates or reorders the draft, so
// these lock the pure matcher: the fit bands, the section-nominal fallback, the
// two-tier grouping (eligible section members vs cross-section members whose range
// fits), the deterministic ranking, and the advisory "unknown" behaviour when a
// range is unset or the line is non-pitched.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    suggestCasting,
    type SingerProfile,
    type VoicePartRange,
    type PartDemand,
} from "../src/index.js";

// MIDI: middle C = 60. Bass section sits low, soprano high, VP is unpitched.
const voiceParts: VoicePartRange[] = [
    {
        voicePartId: "vp-bass",
        nominalLow: 40,
        nominalHigh: 60,
        isPitched: true,
    },
    { voicePartId: "vp-sop", nominalLow: 60, nominalHigh: 81, isPitched: true },
    {
        voicePartId: "vp-vp",
        nominalLow: null,
        nominalHigh: null,
        isPitched: false,
    },
];

const singers: SingerProfile[] = [
    {
        memberId: "m-bass1",
        displayName: "Bass One",
        rangeLow: 36,
        rangeHigh: 62,
        sections: ["vp-bass"],
        homeSection: "vp-bass",
    },
    {
        memberId: "m-bass2",
        displayName: "Bass Two",
        rangeLow: 40,
        rangeHigh: 59,
        sections: ["vp-bass"],
        homeSection: "vp-bass",
    },
    {
        memberId: "m-bass3",
        displayName: "Bass Three",
        rangeLow: 45,
        rangeHigh: 55,
        sections: ["vp-bass"],
        homeSection: "vp-bass",
    },
    {
        memberId: "m-bass4",
        displayName: "Bass Four",
        rangeLow: null,
        rangeHigh: null,
        sections: ["vp-bass"],
        homeSection: "vp-bass",
    },
    {
        memberId: "m-sop1",
        displayName: "Sop One",
        rangeLow: 36,
        rangeHigh: 64,
        sections: ["vp-sop"],
        homeSection: "vp-sop",
    },
    {
        memberId: "m-sop2",
        displayName: "Sop Two",
        rangeLow: 60,
        rangeHigh: 81,
        sections: ["vp-sop"],
        homeSection: "vp-sop",
    },
    {
        memberId: "m-mezzo",
        displayName: "Mezzo",
        rangeLow: 48,
        rangeHigh: 72,
        sections: ["vp-sop"],
        homeSection: "vp-sop",
    },
    {
        memberId: "m-vp",
        displayName: "Beatboxer",
        rangeLow: null,
        rangeHigh: null,
        sections: ["vp-vp"],
        homeSection: "vp-vp",
    },
];

const bassLine = (over: Partial<PartDemand> = {}): PartDemand => ({
    partId: "p-bass",
    label: "Bass",
    voicePartId: "vp-bass",
    rangeLow: null, // no own range: falls back to the section nominal (40..60)
    rangeHigh: null,
    castMemberIds: [],
    ...over,
});

const only = (parts: PartDemand[]) =>
    suggestCasting({ parts, singers, voiceParts });

test("fit bands + section-nominal fallback + two-tier grouping", () => {
    const [s] = only([bassLine()]);
    assert.ok(s);
    assert.equal(
        s.demandLow,
        40,
        "demand falls back to the section nominal low",
    );
    assert.equal(
        s.demandHigh,
        60,
        "demand falls back to the section nominal high",
    );
    assert.equal(s.isPitched, true);
    assert.equal(s.isSolo, false);

    // Primary = every eligible bass, fit annotated, best first: comfortable, edge,
    // out-of-range, unknown. The whole section shows, even the ones who cannot reach it.
    assert.deepEqual(
        s.primary.map((c) => [c.memberId, c.fit]),
        [
            ["m-bass1", "comfortable"],
            ["m-bass2", "edge"],
            ["m-bass3", "out-of-range"],
            ["m-bass4", "unknown"],
        ],
        "eligible basses ranked by fit",
    );
    const b1 = s.primary[0]!;
    assert.equal(b1.headroomLow, 4, "reaches 4 semitones below the demand low");
    assert.equal(
        b1.headroomHigh,
        2,
        "reaches 2 semitones above the demand high",
    );

    // Also-consider = cross-section members whose range genuinely fits (comfortable
    // or edge). Sop One covers it; Sop Two (too high) and the mezzo (too low) do not,
    // so they are excluded rather than listed as poor options.
    assert.deepEqual(
        s.alsoConsider.map((c) => c.memberId),
        ["m-sop1"],
        "only the cross-section singer who fits",
    );
    assert.equal(s.alsoConsider[0]!.fit, "comfortable");
});

test("already-cast members drop out of both groups", () => {
    const [s] = only([bassLine({ castMemberIds: ["m-bass1", "m-sop1"] })]);
    assert.ok(s);
    const ids = [...s.primary, ...s.alsoConsider].map((c) => c.memberId);
    assert.ok(
        !ids.includes("m-bass1"),
        "a cast section member is not re-suggested",
    );
    assert.ok(
        !ids.includes("m-sop1"),
        "a cast cross-section member is not re-suggested",
    );
    assert.equal(
        s.primary[0]!.memberId,
        "m-bass2",
        "the next-best eligible bass leads now",
    );
});

test("a solo has no section: everyone ranks by fit, nothing cross-section", () => {
    // Solo demand C4..G4 (60..67), the part names its own range.
    const solo: PartDemand = {
        partId: "p-solo",
        label: "Lead",
        voicePartId: null,
        rangeLow: 60,
        rangeHigh: 67,
        castMemberIds: [],
    };
    const [s] = only([solo]);
    assert.ok(s);
    assert.equal(s.isSolo, true);
    assert.equal(
        s.alsoConsider.length,
        0,
        "a solo never has a cross-section tier",
    );
    assert.equal(
        s.primary.length,
        singers.length,
        "every singer is a solo candidate",
    );
    // Mezzo (48..72) comfortably covers 60..67; the beatboxer (no range) is unknown, last.
    assert.equal(s.primary[0]!.memberId, "m-mezzo");
    assert.equal(s.primary[0]!.fit, "comfortable");
    assert.equal(
        s.primary.at(-1)!.fit,
        "unknown",
        "a singer with no stated range sorts last",
    );
});

test("a part's own range overrides the section nominal", () => {
    // A bass line that actually sits high (52..64), unlike the section nominal (40..60).
    const line = bassLine({ rangeLow: 52, rangeHigh: 64 });
    const roster: SingerProfile[] = [
        {
            memberId: "hi",
            displayName: "High Bass",
            rangeLow: 50,
            rangeHigh: 66,
            sections: ["vp-bass"],
            homeSection: "vp-bass",
        },
    ];
    const [s] = suggestCasting({ parts: [line], singers: roster, voiceParts });
    assert.ok(s);
    assert.equal(s.demandLow, 52, "the line's own range wins over the nominal");
    assert.equal(s.demandHigh, 64);
    assert.equal(
        s.primary[0]!.fit,
        "comfortable",
        "measured against the own range, not the nominal",
    );
});

test("a half-open part range never splices onto the section nominal", () => {
    // The schema permits a part range with only one bound set. It must NOT borrow the
    // other bound from the section, which could invent (or even invert) the window.
    // With a complete section nominal, fall back to the section whole; else unknown.
    const halfOpen = bassLine({ rangeLow: 72, rangeHigh: null }); // one-sided, section nominal is 40..60
    const roster: SingerProfile[] = [
        {
            memberId: "lo",
            displayName: "Low",
            rangeLow: 36,
            rangeHigh: 64,
            sections: ["vp-bass"],
            homeSection: "vp-bass",
        },
    ];
    const [s] = suggestCasting({
        parts: [halfOpen],
        singers: roster,
        voiceParts,
    });
    assert.ok(s);
    assert.equal(
        s.demandLow,
        40,
        "the half-open part range is skipped; the section nominal is used whole",
    );
    assert.equal(s.demandHigh, 60, "not a spliced 72..60 window");
    assert.equal(
        s.primary[0]!.fit,
        "comfortable",
        "rated against 40..60, not a nonsensical inverted range",
    );
});

test("a half-open range with no complete fallback is unknown, never one-sided", () => {
    const noNominal: VoicePartRange[] = [
        {
            voicePartId: "vp-x",
            nominalLow: null,
            nominalHigh: null,
            isPitched: true,
        },
    ];
    const halfOpen: PartDemand = {
        partId: "p",
        label: "X",
        voicePartId: "vp-x",
        rangeLow: 55,
        rangeHigh: null,
        castMemberIds: [],
    };
    const roster: SingerProfile[] = [
        {
            memberId: "a",
            displayName: "A",
            rangeLow: 48,
            rangeHigh: 72,
            sections: ["vp-x"],
            homeSection: "vp-x",
        },
    ];
    const [s] = suggestCasting({
        parts: [halfOpen],
        singers: roster,
        voiceParts: noNominal,
    });
    assert.ok(s);
    assert.equal(
        s.demandLow,
        null,
        "no source names a complete range, so the demand is unknown",
    );
    assert.equal(s.demandHigh, null);
    assert.equal(
        s.primary[0]!.fit,
        "unknown",
        "not a false fit against a one-sided window",
    );
});

test("a non-pitched section skips range fit and has no cross-section tier", () => {
    const vpLine: PartDemand = {
        partId: "p-vp",
        label: "VP",
        voicePartId: "vp-vp",
        rangeLow: null,
        rangeHigh: null,
        castMemberIds: [],
    };
    const [s] = only([vpLine]);
    assert.ok(s);
    assert.equal(s.isPitched, false);
    assert.deepEqual(
        s.primary.map((c) => c.memberId),
        ["m-vp"],
        "the eligible beatboxer shows",
    );
    assert.equal(
        s.primary[0]!.fit,
        "unknown",
        "range fit is meaningless for vocal percussion",
    );
    assert.equal(
        s.alsoConsider.length,
        0,
        "no cross-section-by-range for a non-pitched line",
    );
});

test("ranking tie-breaks: home section, then name, then id", () => {
    const line: PartDemand = {
        partId: "p",
        label: "Bass",
        voicePartId: "vp-bass",
        rangeLow: null,
        rangeHigh: null,
        castMemberIds: [],
    };
    // Both comfortable with identical headroom; one is home-section, one is not.
    const homeTie: SingerProfile[] = [
        {
            memberId: "bianca",
            displayName: "Bianca",
            rangeLow: 36,
            rangeHigh: 62,
            sections: ["vp-bass"],
            homeSection: "vp-sop",
        },
        {
            memberId: "aaron",
            displayName: "Aaron",
            rangeLow: 36,
            rangeHigh: 62,
            sections: ["vp-bass"],
            homeSection: "vp-bass",
        },
    ];
    const [byHome] = suggestCasting({
        parts: [line],
        singers: homeTie,
        voiceParts,
    });
    assert.deepEqual(
        byHome!.primary.map((c) => c.memberId),
        ["aaron", "bianca"],
        "home section outranks a later-alphabet name",
    );

    // Both comfortable, both home-section: fall through to the name.
    const nameTie: SingerProfile[] = [
        {
            memberId: "z",
            displayName: "Zoe",
            rangeLow: 36,
            rangeHigh: 62,
            sections: ["vp-bass"],
            homeSection: "vp-bass",
        },
        {
            memberId: "a",
            displayName: "Amy",
            rangeLow: 36,
            rangeHigh: 62,
            sections: ["vp-bass"],
            homeSection: "vp-bass",
        },
    ];
    const [byName] = suggestCasting({
        parts: [line],
        singers: nameTie,
        voiceParts,
    });
    assert.deepEqual(
        byName!.primary.map((c) => c.memberId),
        ["a", "z"],
        "name breaks the tie when home section matches",
    );
});

test("edge tolerance is symmetric: within two semitones either way", () => {
    // A solo demanding 50..60; vary the one singer's range against it.
    const solo: PartDemand = {
        partId: "p",
        label: "Lead",
        voicePartId: null,
        rangeLow: 50,
        rangeHigh: 60,
        castMemberIds: [],
    };
    const cases: [string, number, number, string][] = [
        ["comfortable", 48, 62, "comfortable"], // 2 below, 2 above
        ["just covers", 49, 61, "edge"], // 1 of room each end
        ["exact", 50, 60, "edge"], // meets both ends, no room
        ["just misses low", 51, 61, "edge"], // short 1 on the low end
        ["misses by two", 52, 60, "edge"], // short 2 on the low end, still edge
        ["misses by three", 53, 60, "out-of-range"], // short 3, past the tolerance
    ];
    for (const [name, low, high, fit] of cases) {
        const roster: SingerProfile[] = [
            {
                memberId: "x",
                displayName: "X",
                rangeLow: low,
                rangeHigh: high,
                sections: [],
                homeSection: null,
            },
        ];
        const [s] = suggestCasting({
            parts: [solo],
            singers: roster,
            voiceParts,
        });
        assert.equal(s!.primary[0]!.fit, fit, name);
    }
});
