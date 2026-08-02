// Run with: npm test -w apps/web  (tsx test/unit/format.test.ts)
//
// confirmedAgo turns a cover's learned_at into the casting screen's "confirmed N ago"
// caption. `now` is injected so the week/month/year ladder is deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmedAgo, summarizeSeamFlags } from "../../lib/format";
import type { SeamFlag } from "@repertoire/core";

const NOW = new Date("2026-07-07T12:00:00Z");

test("confirmedAgo: buckets by this week, weeks, months, years", () => {
    assert.equal(
        confirmedAgo("2026-07-07", NOW),
        "confirmed today",
        "same day",
    );
    assert.equal(
        confirmedAgo("2026-07-04", NOW),
        "confirmed this week",
        "under a week",
    );
    assert.equal(
        confirmedAgo("2026-06-30", NOW),
        "confirmed 1 week ago",
        "one week, singular",
    );
    assert.equal(
        confirmedAgo("2026-06-23", NOW),
        "confirmed 2 weeks ago",
        "two weeks, plural",
    );
    assert.equal(
        confirmedAgo("2026-06-03", NOW),
        "confirmed 4 weeks ago",
        "still weeks just under the month handoff",
    );
    assert.equal(
        confirmedAgo("2026-06-02", NOW),
        "confirmed 1 month ago",
        "month handoff at 35 days, singular",
    );
    assert.equal(
        confirmedAgo("2026-04-01", NOW),
        "confirmed 3 months ago",
        "months, plural",
    );
    assert.equal(
        confirmedAgo("2025-07-07", NOW),
        "confirmed 1 year ago",
        "one year, singular",
    );
    assert.equal(
        confirmedAgo("2024-07-07", NOW),
        "confirmed 2 years ago",
        "two years, plural",
    );
});

test("confirmedAgo: guards a future date and a bad value", () => {
    assert.equal(
        confirmedAgo("2026-12-01", NOW),
        "confirmed today",
        "a future stamp clamps to today, no negative",
    );
    assert.equal(
        confirmedAgo("not-a-date", NOW),
        "confirmed",
        "an unparseable value degrades quietly",
    );
});

const EF: SeamFlag = "energy-flatline";
const SF: SeamFlag = "same-feel";

test("summarizeSeamFlags: a flag on most transitions collapses to a summary and is stripped inline", () => {
    // energy-flatline on 5 of 6 seams (dominant); same-feel on 2 (a minority, stays inline).
    const seams = [
        { fromId: "a", flags: [EF, SF] },
        { fromId: "b", flags: [EF] },
        { fromId: "c", flags: [EF] },
        { fromId: "d", flags: [EF, SF] },
        { fromId: "e", flags: [EF] },
        { fromId: "f", flags: [] as SeamFlag[] },
    ];
    const s = summarizeSeamFlags(seams);
    assert.deepEqual(
        s.dominant.map((d) => d.flag),
        ["energy-flatline"],
        "the majority flag is dominant",
    );
    assert.equal(s.dominant[0]!.count, 5);
    assert.deepEqual(
        s.reduced.get("a"),
        ["same-feel"],
        "dominant flag stripped, minority flag kept",
    );
    assert.deepEqual(s.reduced.get("b"), []);
    assert.deepEqual(s.reduced.get("d"), ["same-feel"]);
});

test("summarizeSeamFlags: a short set keeps its per-seam flags", () => {
    // Three seams (< 4): below the "real set" floor, so nothing collapses even at 100%.
    const shortSet = [
        { fromId: "a", flags: [EF] },
        { fromId: "b", flags: [EF] },
        { fromId: "c", flags: [EF] },
    ];
    const s = summarizeSeamFlags(shortSet);
    assert.equal(s.dominant.length, 0, "a 3-seam set does not collapse");
    assert.deepEqual(s.reduced.get("a"), [EF]);
});
