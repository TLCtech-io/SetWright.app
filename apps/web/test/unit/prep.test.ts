// Run with: npm test -w apps/web  (tsx test/unit/prep.test.ts)
//
// behindSchedule turns prep targets + readiness/casting signals into a ranked "behind
// schedule" list. Contract: a targeted song counts only when it is not performance-ready
// or not fully cast; each behind song is bound to its SOONEST at-risk gig; rank by days
// left, then title.

import { test } from "node:test";
import assert from "node:assert/strict";

import { behindSchedule, type BehindInput } from "../../lib/prep";

const TODAY = "2026-07-08";
const base = (over: Partial<BehindInput>): BehindInput => ({
    gigs: [],
    titleById: new Map([
        ["s1", "Alpha"],
        ["s2", "Bravo"],
        ["s3", "Charlie"],
    ]),
    notReady: new Set(),
    undercast: new Set(),
    today: TODAY,
    ...over,
});

test("behindSchedule: only at-risk targets, ranked by days left", () => {
    const out = behindSchedule(
        base({
            gigs: [
                {
                    id: "gA",
                    name: "Gala",
                    date: "2026-07-20",
                    targetSongIds: ["s1", "s2"],
                },
                {
                    id: "gB",
                    name: "Bash",
                    date: "2026-08-01",
                    targetSongIds: ["s3"],
                },
            ],
            notReady: new Set(["s1"]),
            undercast: new Set(["s3"]),
        }),
    );
    assert.equal(out.length, 2, "s2 is on track, excluded");
    assert.deepEqual(
        out.map((r) => r.songId),
        ["s1", "s3"],
        "soonest deadline first",
    );
    assert.equal(out[0]!.daysLeft, 12, "s1 due in 12 days");
    assert.equal(
        out[0]!.notReady && !out[0]!.undercast,
        true,
        "s1 flagged not-ready only",
    );
    assert.equal(out[1]!.daysLeft, 24, "s3 due in 24 days");
    assert.equal(
        out[1]!.undercast && !out[1]!.notReady,
        true,
        "s3 flagged undercast only",
    );
});

test("behindSchedule: a song is bound to its soonest at-risk gig, once", () => {
    const out = behindSchedule(
        base({
            gigs: [
                {
                    id: "gB",
                    name: "Bash",
                    date: "2026-08-01",
                    targetSongIds: ["s1"],
                },
                {
                    id: "gA",
                    name: "Gala",
                    date: "2026-07-20",
                    targetSongIds: ["s1"],
                },
            ],
            notReady: new Set(["s1"]),
        }),
    );
    assert.equal(out.length, 1, "deduped to one row");
    assert.equal(
        out[0]!.gigId,
        "gA",
        "bound to the sooner gig regardless of input order",
    );
    assert.equal(out[0]!.deadline, "2026-07-20");
});

test("behindSchedule: both reasons, and on-track book yields nothing", () => {
    const both = behindSchedule(
        base({
            gigs: [
                {
                    id: "gA",
                    name: "Gala",
                    date: "2026-07-20",
                    targetSongIds: ["s1"],
                },
            ],
            notReady: new Set(["s1"]),
            undercast: new Set(["s1"]),
        }),
    );
    assert.equal(
        both[0]!.notReady && both[0]!.undercast,
        true,
        "carries both reasons",
    );

    const clear = behindSchedule(
        base({
            gigs: [
                {
                    id: "gA",
                    name: "Gala",
                    date: "2026-07-20",
                    targetSongIds: ["s1", "s2"],
                },
            ],
        }),
    );
    assert.deepEqual(clear, [], "every target ready, nothing behind");
});

test("behindSchedule: same days left breaks ties by title", () => {
    const out = behindSchedule(
        base({
            gigs: [
                {
                    id: "gA",
                    name: "Gala",
                    date: "2026-07-20",
                    targetSongIds: ["s3", "s1"],
                },
            ],
            notReady: new Set(["s1", "s3"]),
        }),
    );
    assert.deepEqual(
        out.map((r) => r.title),
        ["Alpha", "Charlie"],
        "title asc on equal deadline",
    );
});
