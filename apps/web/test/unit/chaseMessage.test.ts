// Run with: tsx test/unit/chaseMessage.test.ts
//
// The call list keys each person's songs by songId, not title (song titles carry no uniqueness), so
// two distinct chaseable songs that share a title are both counted rather than collapsing to one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chaseCallList } from "../../lib/chaseMessage";

test("chaseCallList: two distinct songs sharing a title are both counted, not collapsed", () => {
    const chase = [
        {
            songId: "s1",
            title: "Hallelujah",
            secondsUnlocked: 200,
            chase: [{ memberId: "m1", displayName: "Ana", partLabel: "Alto" }],
        },
        {
            songId: "s2",
            title: "Hallelujah",
            secondsUnlocked: 180,
            chase: [{ memberId: "m1", displayName: "Ana", partLabel: "Alto" }],
        },
    ];
    const list = chaseCallList(chase, "the gig");
    assert.equal(list.length, 1, "one person to call");
    assert.equal(
        list[0]!.songs.length,
        2,
        "both same-titled songs are counted (keyed by id, not title)",
    );
    assert.equal(
        list[0]!.totalSeconds,
        380,
        "total sums both songs, no undercount",
    );
});

test("chaseCallList: ranks the person who unlocks more songs first", () => {
    const chase = [
        {
            songId: "s1",
            title: "A",
            secondsUnlocked: 100,
            chase: [
                { memberId: "m1", displayName: "Ana", partLabel: "Alto" },
                { memberId: "m2", displayName: "Bo", partLabel: "Bass" },
            ],
        },
        {
            songId: "s2",
            title: "B",
            secondsUnlocked: 100,
            chase: [{ memberId: "m1", displayName: "Ana", partLabel: "Alto" }],
        },
    ];
    const list = chaseCallList(chase);
    assert.equal(
        list[0]!.memberId,
        "m1",
        "Ana (2 songs) ranks above Bo (1 song)",
    );
});
