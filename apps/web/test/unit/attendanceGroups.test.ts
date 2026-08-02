// Run with: npm test -w apps/web  (tsx test/unit/attendanceGroups.test.ts)
//
// attendanceGroups projects an event's availability + the active roster into who is coming,
// grouped by home section. Contract: sections in vocab order (unassigned last, empty omitted),
// members bucketed by their home (primary, else first) section, split into in/tentative/out/
// pending (pending = no response row), each name list sorted, and ONLY names in the output.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    attendanceGroups,
    type AttendanceMember,
    type AttendanceVocab,
    type AttendanceAvailability,
} from "../../lib/attendanceGroups";

const VOCAB: AttendanceVocab[] = [
    { id: "sop", label: "Soprano", sortOrder: 0 },
    { id: "alt", label: "Alto", sortOrder: 1 },
    { id: "ten", label: "Tenor", sortOrder: 2 },
    { id: "bas", label: "Bass", sortOrder: 3 },
];

const member = (
    id: string,
    name: string,
    sections: AttendanceMember["sections"],
): AttendanceMember => ({
    id,
    displayName: name,
    sections,
});
const home = (voicePartId: string) => [{ voicePartId, isPrimary: true }];

test("groups by home section in vocab order; empty sections omitted", () => {
    const roster = [
        member("m1", "Ana", home("sop")),
        member("m2", "Ben", home("bas")),
    ];
    const groups = attendanceGroups([], roster, VOCAB);
    // Only Soprano and Bass have members; Alto and Tenor are omitted; order follows sortOrder.
    assert.deepEqual(
        groups.map((g) => g.section),
        ["Soprano", "Bass"],
    );
});

test("splits by response; a member with no row is pending", () => {
    const roster = [
        member("m1", "Ana", home("sop")),
        member("m2", "Bea", home("sop")),
        member("m3", "Cy", home("sop")),
        member("m4", "Dot", home("sop")),
    ];
    const availability: AttendanceAvailability[] = [
        { memberId: "m1", status: "in" },
        { memberId: "m2", status: "tentative" },
        { memberId: "m3", status: "out" },
        // m4 has no row -> pending
    ];
    const [sop] = attendanceGroups(availability, roster, VOCAB);
    assert.deepEqual(sop!.in, ["Ana"]);
    assert.deepEqual(sop!.tentative, ["Bea"]);
    assert.deepEqual(sop!.out, ["Cy"]);
    assert.deepEqual(sop!.pending, ["Dot"]);
});

test("a multi-section member is grouped under their home (primary), not their first listed", () => {
    // Cleo lists Alto (not primary) first, Soprano (primary) second: she belongs under Soprano.
    const cleo = member("m5", "Cleo", [
        { voicePartId: "alt", isPrimary: false },
        { voicePartId: "sop", isPrimary: true },
    ]);
    const groups = attendanceGroups(
        [{ memberId: "m5", status: "in" }],
        [cleo],
        VOCAB,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.section, "Soprano");
    assert.deepEqual(groups[0]!.in, ["Cleo"]);
});

test("no primary flagged: falls back to the first listed section", () => {
    const m = member("m6", "Fio", [
        { voicePartId: "ten", isPrimary: false },
        { voicePartId: "bas", isPrimary: false },
    ]);
    const groups = attendanceGroups([], [m], VOCAB);
    assert.equal(groups[0]!.section, "Tenor");
});

test("names are sorted within each bucket", () => {
    const roster = [
        member("m1", "Zed", home("bas")),
        member("m2", "Amy", home("bas")),
        member("m3", "Mel", home("bas")),
    ];
    const av: AttendanceAvailability[] = [
        { memberId: "m1", status: "in" },
        { memberId: "m2", status: "in" },
        { memberId: "m3", status: "in" },
    ];
    const [bas] = attendanceGroups(av, roster, VOCAB);
    assert.deepEqual(bas!.in, ["Amy", "Mel", "Zed"]);
});

test("a member with no section goes to an Unassigned bucket, placed last", () => {
    const roster = [member("m1", "Ana", home("sop")), member("m2", "Gus", [])];
    const groups = attendanceGroups([], roster, VOCAB);
    assert.deepEqual(
        groups.map((g) => g.section),
        ["Soprano", "Unassigned"],
    );
    assert.equal(groups[1]!.sectionId, null);
    assert.deepEqual(groups[1]!.pending, ["Gus"]);
});

test("a home pointing at an unknown section id falls to Unassigned, never dropped", () => {
    const roster = [member("m1", "Ghost", home("vanished-vp"))];
    const groups = attendanceGroups(
        [{ memberId: "m1", status: "in" }],
        roster,
        VOCAB,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.section, "Unassigned");
    assert.deepEqual(groups[0]!.in, ["Ghost"]);
});

test("empty roster yields no groups", () => {
    assert.deepEqual(
        attendanceGroups([{ memberId: "x", status: "in" }], [], VOCAB),
        [],
    );
});
