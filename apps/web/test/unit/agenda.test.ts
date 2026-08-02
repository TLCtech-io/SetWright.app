// Run with: npm test -w apps/web  (tsx test/unit/agenda.test.ts)
//
// suggestAgenda merges the four rehearsal signals into one ranked list. The ranking
// contract: coverage risk > learning gap > staleness > upcoming gig, then more signals
// first, then title. A song hitting several signals collects all of them as reasons.

import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestAgenda, type AgendaSignals } from "../../lib/agenda";
import type { BusFactorRow } from "../../lib/insights";
import type { LearningSong } from "../../lib/learning";

const undercast = (
    songId: string,
    title: string,
    label: string,
): BusFactorRow => ({
    songId,
    title,
    kind: "undercast",
    shortParts: [{ label, needed: 1, covered: 0 }],
    critical: [],
});
const singlePoint = (
    songId: string,
    title: string,
    name: string,
    parts: string[],
): BusFactorRow => ({
    songId,
    title,
    kind: "single-point",
    shortParts: [],
    critical: [{ memberId: `m-${name}`, displayName: name, parts }],
});
const learning = (
    songId: string,
    title: string,
    covers: number,
): LearningSong => ({
    songId,
    title,
    covers: Array.from({ length: covers }, (_, i) => ({
        memberId: `m${i}`,
        partId: `p${i}`,
        displayName: `M${i}`,
        partLabel: "Alto",
        assessed: null,
    })),
});

const empty: AgendaSignals = {
    coverageRisk: [],
    learning: [],
    stale: [],
    upcoming: [],
};

test("suggestAgenda: orders by most-urgent reason kind", () => {
    const out = suggestAgenda({
        ...empty,
        coverageRisk: [undercast("cov", "Coverage", "Bass")],
        learning: [learning("learn", "Learning", 2)],
        stale: [{ songId: "stale", title: "Stale", days: 120 }],
        upcoming: [{ songId: "up", title: "Upcoming", eventNames: ["Gala"] }],
    });
    assert.deepEqual(
        out.map((s) => s.songId),
        ["cov", "learn", "stale", "up"],
        "priority order",
    );
    assert.equal(out[0]!.reasons[0]!.detail, "Undercast: Bass short");
    assert.equal(out[1]!.reasons[0]!.detail, "2 covers unassessed");
    assert.equal(out[2]!.reasons[0]!.detail, "Not rehearsed in 120 days");
    assert.equal(out[3]!.reasons[0]!.detail, "For Gala");
});

test("suggestAgenda: a song hitting several signals collects them, reasons priority-ordered", () => {
    const out = suggestAgenda({
        ...empty,
        coverageRisk: [singlePoint("x", "X", "Ana", ["Bass"])],
        stale: [{ songId: "x", title: "X", days: 95 }],
        upcoming: [
            { songId: "x", title: "X", eventNames: ["Spring", "Summer"] },
        ],
    });
    assert.equal(out.length, 1, "merged to one suggestion");
    assert.deepEqual(
        out[0]!.reasons.map((r) => r.kind),
        ["coverage-risk", "stale", "upcoming-gig"],
        "reasons ordered by priority within the song",
    );
    assert.equal(out[0]!.reasons[0]!.detail, "Only Ana covers Bass");
    assert.equal(
        out[0]!.reasons[2]!.detail,
        "For Spring +1",
        "multiple events summarized",
    );
});

test("suggestAgenda: same top reason, more signals wins, then title", () => {
    const out = suggestAgenda({
        ...empty,
        learning: [
            learning("b", "Bravo", 1),
            learning("a", "Alpha", 1),
            learning("c", "Charlie", 1),
        ],
        stale: [
            { songId: "a", title: "Alpha", days: 100 },
            { songId: "c", title: "Charlie", days: 100 },
        ],
    });
    // a and c both have learning+stale (2 reasons); b has 1. a before c by title.
    assert.deepEqual(
        out.map((s) => s.songId),
        ["a", "c", "b"],
        "count desc, then title asc",
    );
});

test("suggestAgenda: single-point with no named parts, and no signals", () => {
    assert.deepEqual(suggestAgenda(empty), [], "empty in, empty out");
    const out = suggestAgenda({
        ...empty,
        coverageRisk: [singlePoint("y", "Y", "Bo", [])],
    });
    assert.equal(
        out[0]!.reasons[0]!.detail,
        "Only Bo covers",
        "degrades without a part label",
    );
});
