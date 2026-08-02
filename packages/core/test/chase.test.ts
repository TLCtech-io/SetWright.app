// Run with: npm test
//
// The chase lever: which feasibility-blocked songs a tentative or no-response
// RSVP would open, and who to chase. Out is a real no. Attribution runs through
// the optimistic matching, so a cross-cast cover is still named.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    computeChase,
    type AvailabilityStatus,
    type Casting,
    type DraftInput,
    type Part,
    type ResolvedEvent,
    type Song,
} from "../src/index.js";

const EVENT: ResolvedEvent = {
    id: "ev",
    eventDate: null,
    targetDurationSeconds: null,
    maxDurationSeconds: null,
    allowsOnBook: true,
    allowsExplicit: true,
    allowsAccompaniment: true,
    padding: { perSongSeconds: 0, perSetSeconds: 0 },
};

function song(id: string): Song {
    return {
        id,
        title: id,
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
    };
}

function part(id: string, label: string): Part {
    return { id, songId: "s", isRequired: true, countNeeded: 1, label };
}

function cast(partId: string, memberId: string): Casting {
    return {
        partId,
        memberId,
        isPrimary: true,
        confidence: "solid",
        directorAssessed: null,
    };
}

// A VP song only Vic can cover, plus Vic's availability and whether the roster
// knows him. The drafter cannot draft the song without Vic on VP.
function input(
    vic: AvailabilityStatus | "no-row",
    opts: { onRoster?: boolean } = {},
): DraftInput {
    const availability =
        vic === "no-row" ? [] : [{ memberId: "vic", status: vic }];
    const members =
        opts.onRoster === false
            ? undefined
            : [{ id: "vic", displayName: "Vic" }];
    return {
        songs: [song("s")],
        parts: [part("s-vp", "VP")],
        castings: [cast("s-vp", "vic")],
        availability,
        event: EVENT,
        members,
    };
}

test("a tentative cover makes the song chaseable and names the cover", () => {
    const chase = computeChase(input("tentative"));
    assert.equal(chase.length, 1);
    assert.equal(chase[0]!.songId, "s");
    assert.equal(chase[0]!.secondsUnlocked, 120);
    assert.deepEqual(chase[0]!.chase, [
        { memberId: "vic", displayName: "Vic", partLabel: "VP" },
    ]);
});

test("an out cover is a real no, not chaseable", () => {
    assert.equal(computeChase(input("out")).length, 0);
});

test("a no-response cover is chaseable when the roster knows the singer", () => {
    const chase = computeChase(input("no-row"));
    assert.equal(chase.length, 1);
    assert.equal(chase[0]!.chase[0]!.memberId, "vic");
});

test("a no-response cover is invisible without a roster", () => {
    assert.equal(computeChase(input("no-row", { onRoster: false })).length, 0);
});

test("a feasible song is not a chase candidate", () => {
    assert.equal(computeChase(input("in")).length, 0);
});

test("a song that would still fail readiness is not a false lever", () => {
    const i = input("tentative");
    i.songs[0]!.assessedReadiness = "dormant"; // below the default floor
    assert.equal(computeChase(i).length, 0);
});

test("a preferred song below the floor IS chaseable (prep bypasses the readiness gate)", () => {
    // The funnel lets a preferred (prep) song bypass readiness, so the chase must agree: a chased
    // RSVP that makes a below-floor commitment castable would put it in the set, so it is a real lever.
    const i = input("tentative");
    i.songs[0]!.assessedReadiness = "dormant";
    i.options = { prefer: ["s"] };
    const chase = computeChase(i);
    assert.equal(
        chase.length,
        1,
        "the committed prep song surfaces a chase lever",
    );
    assert.equal(chase[0]!.chase[0]!.memberId, "vic");
});

test("a kept song is already placed, so it is never named as chaseable", () => {
    const i = input("tentative");
    i.options = { keep: ["s"] };
    assert.equal(computeChase(i).length, 0);
});

test("a cross-cast cover is named even when it frees someone for the short part", () => {
    // Anna (in) covers A and B; Bob (tentative) covers only A. With Anna alone the
    // song is short. Chasing Bob opens it: Bob takes A, Anna takes B. The lever
    // must name Bob, though the part that read as short was B, which Bob cannot cover.
    const chase = computeChase({
        songs: [song("s")],
        parts: [part("a", "A"), part("b", "B")],
        castings: [
            cast("a", "anna"),
            {
                partId: "b",
                memberId: "anna",
                isPrimary: false,
                confidence: "solid",
                directorAssessed: null,
            },
            {
                partId: "a",
                memberId: "bob",
                isPrimary: false,
                confidence: "solid",
                directorAssessed: null,
            },
        ],
        availability: [
            { memberId: "anna", status: "in" },
            { memberId: "bob", status: "tentative" },
        ],
        event: EVENT,
        members: [
            { id: "anna", displayName: "Anna" },
            { id: "bob", displayName: "Bob" },
        ],
    });
    assert.equal(chase.length, 1);
    assert.deepEqual(chase[0]!.chase, [
        { memberId: "bob", displayName: "Bob", partLabel: "A" },
    ]);
});

test("with tentatives counted, only the newly-available no-response is named", () => {
    // Tina (tentative) is counted into the baseline by the option, so chasing her
    // is moot. Nemo (no-response) is the real lever, on the part Tina does not cover.
    const chase = computeChase({
        songs: [song("s")],
        parts: [part("p1", "P1"), part("p2", "P2")],
        castings: [cast("p1", "tina"), cast("p2", "nemo")],
        availability: [{ memberId: "tina", status: "tentative" }],
        event: EVENT,
        members: [
            { id: "tina", displayName: "Tina" },
            { id: "nemo", displayName: "Nemo" },
        ],
        options: { countTentativeAsAvailable: true },
    });
    assert.equal(chase.length, 1);
    assert.deepEqual(chase[0]!.chase, [
        { memberId: "nemo", displayName: "Nemo", partLabel: "P2" },
    ]);
});

test("a song short on two parts names a chase target for each", () => {
    const chase = computeChase({
        songs: [song("s")],
        parts: [part("p1", "P1"), part("p2", "P2")],
        castings: [cast("p1", "ana"), cast("p2", "ben")],
        availability: [],
        event: EVENT,
        members: [
            { id: "ana", displayName: "Ana" },
            { id: "ben", displayName: "Ben" },
        ],
    });
    assert.equal(chase.length, 1);
    const byMember = Object.fromEntries(
        chase[0]!.chase.map((t) => [t.memberId, t.partLabel]),
    );
    assert.deepEqual(byMember, { ana: "P1", ben: "P2" });
});
