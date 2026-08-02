// Run with: npm test -w apps/web  (tsx test/unit/coercers.test.ts)
//
// The REPLACE coercers (casting, availability, playground songs) are strict: an empty array is an
// intentional clear, but ANY malformed or out-of-scope entry — and any over-cap list — is rejected
// (-> 400), never silently dropped or truncated, so a bad payload cannot delete the stored rows the
// dropped entries map to. Only harmless normalizations (dedupe, one-primary-per-part) stay.

import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceCasting } from "../../lib/castingInput";
import { coercePlaygroundPatch } from "../../lib/playgroundInput";
import { coerceMemberInput } from "../../lib/memberInput";
import { coerceAvailability, coerceEventInput } from "../../lib/eventInput";
import { coerceNote } from "../../lib/noteInput";
import { coerceTransition } from "../../lib/transitionInput";
import { coerceBreaks } from "../../lib/breakInput";
import { coerceSongInput } from "../../lib/songInput";
import { coerceConfidence } from "../../lib/confidenceInput";
import { coerceEventTypeInput } from "../../lib/eventTypeInput";
import { coerceReorderInput } from "../../lib/reorderInput";
import {
    coercePrepSongIds,
    coerceAgendaItems,
    coerceRecordInput,
} from "../../lib/rehearsalInput";
import { MAX_FORM_ITEMS, MAX_SET_IDS } from "../../lib/limits";

test("coerceCasting: empty clears; any malformed/unknown/over-cap entry rejects", () => {
    const parts = new Set(["part-1"]);
    const members = new Set(["mem-1"]);
    assert.deepEqual(
        coerceCasting({ castings: [] }, parts, members),
        [],
        "empty array is an intentional clear",
    );
    const ok = coerceCasting(
        { castings: [{ partId: "part-1", memberId: "mem-1" }] },
        parts,
        members,
    );
    assert.equal(ok?.length, 1, "a fully-valid list passes");
    assert.equal(
        coerceCasting(
            {
                castings: [
                    { partId: "part-1", memberId: "mem-1" },
                    { partId: "ghost", memberId: "mem-1" },
                ],
            },
            parts,
            members,
        ),
        null,
        "a mixed valid+unknown list is rejected, not partially saved",
    );
    assert.equal(
        coerceCasting(
            { castings: [{ partId: "part-1", memberId: "mem-1" }, "junk"] },
            parts,
            members,
        ),
        null,
        "a non-object entry is rejected",
    );
    assert.equal(
        coerceCasting({ castings: "nope" }, parts, members),
        null,
        "a non-array is rejected",
    );
    const over = Array.from({ length: MAX_FORM_ITEMS + 1 }, () => ({
        partId: "part-1",
        memberId: "mem-1",
    }));
    assert.equal(
        coerceCasting({ castings: over }, parts, members),
        null,
        "an over-cap list is rejected, not truncated",
    );
});

test("coercePlaygroundPatch: empty clears; any unknown/over-cap song id rejects", () => {
    const valid = new Set(["s1", "s2"]);
    assert.deepEqual(coercePlaygroundPatch({ songIds: [] }, valid), {
        ok: true,
        value: { songIds: [] },
    });
    assert.deepEqual(coercePlaygroundPatch({ songIds: ["s1", "s2"] }, valid), {
        ok: true,
        value: { songIds: ["s1", "s2"] },
    });
    assert.equal(
        coercePlaygroundPatch({ songIds: ["s1", "ghost"] }, valid).ok,
        false,
        "a mixed valid+unknown list is rejected",
    );
    const over = Array.from({ length: MAX_FORM_ITEMS + 1 }, () => "s1");
    assert.equal(
        coercePlaygroundPatch({ songIds: over }, valid).ok,
        false,
        "an over-cap list is rejected",
    );
});

test("coerceMemberInput: empty sections clear, nonempty-all-invalid rejects", () => {
    const vps = [{ id: "vp1" }] as Parameters<typeof coerceMemberInput>[1];
    const base = { displayName: "Sam" };
    const cleared = coerceMemberInput({ ...base, voicePartIds: [] }, vps);
    assert.ok(
        cleared.ok && cleared.value.sections.length === 0,
        "empty section list clears",
    );
    assert.equal(
        coerceMemberInput({ ...base, voicePartIds: ["ghost"] }, vps).ok,
        false,
        "all-invalid sections rejected",
    );
});

test("coerceAvailability: empty clears; any malformed/unknown/over-cap entry rejects", () => {
    const members = new Set(["m1"]);
    assert.deepEqual(
        coerceAvailability({ availability: [] }, members),
        [],
        "empty array is an intentional clear",
    );
    assert.equal(
        coerceAvailability(
            { availability: [{ memberId: "m1", status: "in" }] },
            members,
        )?.length,
        1,
        "a fully-valid list passes",
    );
    assert.equal(
        coerceAvailability(
            {
                availability: [
                    { memberId: "m1", status: "in" },
                    { memberId: "ghost", status: "in" },
                ],
            },
            members,
        ),
        null,
        "a mixed valid+unknown list is rejected",
    );
    assert.equal(
        coerceAvailability(
            { availability: [{ memberId: "m1", status: "bogus" }] },
            members,
        ),
        null,
        "a bad status is rejected",
    );
    assert.equal(
        coerceAvailability({ availability: "nope" }, members),
        null,
        "a non-array is rejected",
    );
});

// --- Destructive coercers are strict: a mistype must not silently clear or drop a value ---

test("coerceNote: string/empty/absent sets-or-clears; a wrong-typed note rejects", () => {
    const songs = new Set(["s1"]);
    assert.deepEqual(coerceNote({ songId: "s1", note: "hi" }, songs), {
        ok: true,
        value: { songId: "s1", note: "hi" },
    });
    assert.deepEqual(
        coerceNote({ songId: "s1", note: "" }, songs),
        { ok: true, value: { songId: "s1", note: "" } },
        "empty clears",
    );
    assert.deepEqual(
        coerceNote({ songId: "s1" }, songs),
        { ok: true, value: { songId: "s1", note: "" } },
        "absent clears",
    );
    assert.equal(
        coerceNote({ songId: "s1", note: 42 }, songs).ok,
        false,
        "a numeric note is rejected, not treated as a clear",
    );
});

test("coerceTransition: number sets, null/absent clears; a string or negative rejects", () => {
    const songs = new Set(["s1"]);
    assert.deepEqual(coerceTransition({ songId: "s1", seconds: 30 }, songs), {
        ok: true,
        value: { songId: "s1", seconds: 30 },
    });
    assert.deepEqual(
        coerceTransition({ songId: "s1", seconds: null }, songs),
        { ok: true, value: { songId: "s1", seconds: null } },
        "null clears",
    );
    assert.deepEqual(
        coerceTransition({ songId: "s1" }, songs),
        { ok: true, value: { songId: "s1", seconds: null } },
        "absent clears",
    );
    assert.equal(
        coerceTransition({ songId: "s1", seconds: "30" }, songs).ok,
        false,
        "a string seconds is rejected, not treated as a clear",
    );
    assert.equal(
        coerceTransition({ songId: "s1", seconds: -5 }, songs).ok,
        false,
        "a negative seconds is rejected",
    );
});

test("coercePlaygroundPatch anchors: null unpins, unknown/wrong-typed rejects", () => {
    const valid = new Set(["s1", "s2"]);
    assert.deepEqual(coercePlaygroundPatch({ open: "s1" }, valid), {
        ok: true,
        value: { open: "s1" },
    });
    assert.deepEqual(
        coercePlaygroundPatch({ open: null }, valid),
        { ok: true, value: { open: null } },
        "explicit null unpins",
    );
    assert.equal(
        coercePlaygroundPatch({ open: "ghost" }, valid).ok,
        false,
        "an unknown opener is rejected, not silently unpinned",
    );
    assert.equal(
        coercePlaygroundPatch({ close: 42 }, valid).ok,
        false,
        "a non-string closer is rejected",
    );
    assert.equal(
        coercePlaygroundPatch({ songIds: ["s1"], open: "s2" }, valid).ok,
        false,
        "an opener outside the patch songIds is rejected",
    );
});

test("coerceBreaks: a replace write rejects any malformed entry, dedupes slots", () => {
    assert.deepEqual(
        coerceBreaks({ breaks: [] }),
        { ok: true, value: [] },
        "empty clears",
    );
    const ok = coerceBreaks({
        breaks: [{ id: "b1", afterPosition: 2, durationSeconds: 60 }],
    });
    assert.ok(ok.ok && ok.value.length === 1, "a valid list passes");
    assert.equal(
        coerceBreaks({ breaks: [{ id: "b1", afterPosition: 2 }, "junk"] }).ok,
        false,
        "a non-object entry is rejected, not dropped",
    );
    assert.equal(
        coerceBreaks({ breaks: [{ id: "b1", afterPosition: 0 }] }).ok,
        false,
        "a slot < 1 is rejected",
    );
    assert.equal(
        coerceBreaks({ breaks: [{ afterPosition: 2 }] }).ok,
        false,
        "a missing id is rejected",
    );
    const dup = coerceBreaks({
        breaks: [
            { id: "a", afterPosition: 2 },
            { id: "b", afterPosition: 2 },
        ],
    });
    assert.ok(
        dup.ok && dup.value.length === 1,
        "a duplicate slot collapses to one (harmless normalize)",
    );
});

test("coerceSongInput: a non-object part rejects; a blank-label row is still dropped", () => {
    const song = (parts: unknown[]) =>
        coerceSongInput({ title: "X", parts }, [], []);
    assert.equal(
        song(["junk"]).ok,
        false,
        "a non-object part is rejected, not silently dropped",
    );
    const blank = song([{ label: "  " }]);
    assert.ok(
        blank.ok && blank.value.parts.length === 0,
        "a blank-label row is dropped (form UX), not rejected",
    );
});

test("coerceEventInput: a per-set overhead >= target is rejected", () => {
    const vocab = new Set<string>();
    const types = new Set<string>();
    assert.equal(
        coerceEventInput(
            { name: "Gig", targetDurationSeconds: 100, perSetSeconds: 600 },
            vocab,
            types,
        ).ok,
        false,
        "overhead >= target rejects",
    );
    assert.equal(
        coerceEventInput(
            { name: "Gig", targetDurationSeconds: 3600, perSetSeconds: 90 },
            vocab,
            types,
        ).ok,
        true,
        "a sane overhead passes",
    );
    assert.equal(
        coerceEventInput({ name: "Gig", perSetSeconds: 600 }, vocab, types).ok,
        true,
        "no target: no relationship to enforce",
    );
});

// --- New guards from the 2026-07-17 bug-audit fixes ---

test("coerceSongInput: an end key/tempo without its start is rejected (schema pairing CHECK)", () => {
    const K = (fifths: number, mode: "major" | "minor" = "major") => ({
        fifths,
        mode,
    });
    const song = (extra: Record<string, unknown>) =>
        coerceSongInput({ title: "X", ...extra }, [], []);
    assert.equal(
        song({ endKey: K(2) }).ok,
        false,
        "end key without start key rejects (was a raw 500 on save)",
    );
    assert.equal(
        song({ endTempoBpm: 120 }).ok,
        false,
        "end tempo without start tempo rejects",
    );
    assert.ok(
        song({ startKey: K(0), endKey: K(2) }).ok,
        "start + end key together passes",
    );
    assert.ok(
        song({ startTempoBpm: 90, endTempoBpm: 120 }).ok,
        "start + end tempo together passes",
    );
    assert.ok(song({ startKey: K(0) }).ok, "a start key alone passes");
});

test("coerceSongInput: a sub-unit duration/tempo becomes null, not a 0 that violates the > 0 CHECK", () => {
    const r = coerceSongInput(
        { title: "X", durationSeconds: 0.4, startTempoBpm: 0.3 },
        [],
        [],
    );
    assert.ok(r.ok, "a sub-unit number does not reject");
    if (r.ok) {
        assert.equal(
            r.value.song.durationSeconds,
            null,
            "0.4s rounds to null (no duration), not 0",
        );
        assert.equal(
            r.value.song.startTempoBpm,
            null,
            "0.3 bpm rounds to null, not 0",
        );
    }
});

test("coerceConfidence: a non-uuid partId is rejected (would 22P02 the uuid column -> 500)", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    assert.equal(
        coerceConfidence({ partId: "not-a-uuid", confidence: "solid" }).ok,
        false,
        "a non-uuid partId rejects",
    );
    assert.equal(
        coerceConfidence({ partId: "", confidence: "solid" }).ok,
        false,
        "an empty partId rejects",
    );
    assert.deepEqual(
        coerceConfidence({ partId: uuid, confidence: "solid" }),
        { ok: true, partId: uuid, confidence: "solid" },
        "a uuid partId passes",
    );
    assert.deepEqual(
        coerceConfidence({ partId: uuid, confidence: null }),
        { ok: true, partId: uuid, confidence: null },
        "null un-reports",
    );
    assert.equal(
        coerceConfidence({ partId: uuid, confidence: "bogus" }).ok,
        false,
        "a bad confidence level rejects",
    );
});

test("coerceEventTypeInput: a non-uuid paddingProfileId drops to null (would 22P02 the lookup -> 500)", () => {
    const vocab = new Set<string>();
    const bad = coerceEventTypeInput(
        { name: "Concert", paddingProfileId: "not-a-uuid" },
        vocab,
    );
    assert.ok(
        bad.ok && bad.value.paddingProfileId === null,
        "a non-uuid paddingProfileId drops to null",
    );
    const uuid = "22222222-2222-2222-2222-222222222222";
    const good = coerceEventTypeInput(
        { name: "Concert", paddingProfileId: uuid },
        vocab,
    );
    assert.ok(
        good.ok && good.value.paddingProfileId === uuid,
        "a uuid paddingProfileId is kept",
    );
});

test("coerceEventInput: a sub-unit target duration becomes null, not a 0 that violates the > 0 CHECK", () => {
    const r = coerceEventInput(
        { name: "Gig", targetDurationSeconds: 0.4 },
        new Set<string>(),
        new Set<string>(),
    );
    assert.ok(
        r.ok && r.value.targetDurationSeconds === null,
        "0.4 target rounds to null (no target), not 0",
    );
});

test("coercePrepSongIds: empty clears; malformed/unknown/over-cap rejects; dupes normalize", () => {
    const valid = new Set(["s1", "s2"]);
    assert.deepEqual(
        coercePrepSongIds({ songIds: [] }, valid),
        [],
        "empty array is an intentional clear",
    );
    assert.deepEqual(
        coercePrepSongIds({ songIds: ["s1", "s2"] }, valid),
        ["s1", "s2"],
        "valid list passes",
    );
    assert.deepEqual(
        coercePrepSongIds({ songIds: ["s1", "s1"] }, valid),
        ["s1"],
        "duplicate normalized",
    );
    assert.equal(
        coercePrepSongIds({ songIds: ["s1", "ghost"] }, valid),
        null,
        "a mixed valid+unknown list is rejected, not partially saved",
    );
    assert.equal(
        coercePrepSongIds({ songIds: ["s1", 42] }, valid),
        null,
        "a non-string id is rejected",
    );
    assert.equal(
        coercePrepSongIds({ songIds: "nope" }, valid),
        null,
        "a non-array is rejected",
    );
    assert.equal(
        coercePrepSongIds(
            { songIds: Array.from({ length: MAX_FORM_ITEMS + 1 }, () => "s1") },
            valid,
        ),
        null,
        "over-cap rejects",
    );
});

test("coerceAgendaItems: empty clears; unknown song / bad reason / bad note rejects; dupes normalize", () => {
    const valid = new Set(["s1", "s2"]);
    assert.deepEqual(
        coerceAgendaItems({ items: [] }, valid),
        [],
        "empty clears",
    );
    assert.deepEqual(
        coerceAgendaItems(
            {
                items: [
                    { songId: "s1", reason: "stale", note: "  x  " },
                    { songId: "s2" },
                ],
            },
            valid,
        ),
        [
            { songId: "s1", reason: "stale", note: "x" },
            { songId: "s2", reason: null, note: null },
        ],
        "valid passes; note trimmed; reason/note default to null",
    );
    assert.equal(
        coerceAgendaItems(
            { items: [{ songId: "s1" }, { songId: "s1" }] },
            valid,
        )?.length,
        1,
        "duplicate song normalized",
    );
    assert.equal(
        coerceAgendaItems(
            { items: [{ songId: "s1" }, { songId: "ghost" }] },
            valid,
        ),
        null,
        "a mixed valid+unknown list is rejected",
    );
    assert.equal(
        coerceAgendaItems(
            { items: [{ songId: "s1", reason: "bogus" }] },
            valid,
        ),
        null,
        "a bad reason is rejected",
    );
    assert.equal(
        coerceAgendaItems({ items: [{ songId: "s1", note: 42 }] }, valid),
        null,
        "a wrong-typed note is rejected",
    );
    assert.equal(
        coerceAgendaItems({ items: ["junk"] }, valid),
        null,
        "a non-object item is rejected",
    );
    assert.equal(
        coerceAgendaItems({ items: "nope" }, valid),
        null,
        "a non-array is rejected",
    );
});

test("coerceRecordInput: date falls back; arrays strict; dupes normalize", () => {
    const songs = new Set(["s1"]);
    const mems = new Set(["m1", "m2"]);
    assert.deepEqual(
        coerceRecordInput(
            {
                date: "2026-07-15",
                rehearsedSongIds: ["s1"],
                attendance: [{ memberId: "m1", present: true }],
            },
            songs,
            mems,
            "2026-01-01",
        ),
        {
            date: "2026-07-15",
            rehearsedSongIds: ["s1"],
            attendance: [{ memberId: "m1", present: true }],
        },
        "a fully-valid body passes",
    );
    assert.equal(
        coerceRecordInput(
            { date: "2026-02-30", rehearsedSongIds: [], attendance: [] },
            songs,
            mems,
            "2026-01-01",
        )?.date,
        "2026-01-01",
        "a rolled-over calendar date falls back to the event date",
    );
    assert.equal(
        coerceRecordInput(
            { date: "x", rehearsedSongIds: [], attendance: [] },
            songs,
            mems,
            null,
        ),
        null,
        "no valid date and no fallback rejects",
    );
    assert.equal(
        coerceRecordInput(
            { date: "2026-07-15", rehearsedSongIds: ["ghost"], attendance: [] },
            songs,
            mems,
            null,
        ),
        null,
        "an unknown rehearsed song rejects",
    );
    assert.equal(
        coerceRecordInput(
            {
                date: "2026-07-15",
                rehearsedSongIds: [],
                attendance: [{ memberId: "ghost", present: true }],
            },
            songs,
            mems,
            null,
        ),
        null,
        "an unknown attendance member rejects",
    );
    assert.equal(
        coerceRecordInput(
            {
                date: "2026-07-15",
                rehearsedSongIds: [],
                attendance: [{ memberId: "m1", present: "yes" }],
            },
            songs,
            mems,
            null,
        ),
        null,
        "a non-boolean present rejects",
    );
    assert.equal(
        coerceRecordInput(
            {
                date: "2026-07-15",
                rehearsedSongIds: [],
                attendance: [
                    { memberId: "m1", present: true },
                    { memberId: "m1", present: false },
                ],
            },
            songs,
            mems,
            null,
        )?.attendance.length,
        1,
        "a duplicate member is normalized",
    );
});

test("coerceReorderInput: shape and cardinality", () => {
    assert.deepEqual(
        coerceReorderInput({ order: ["a", "b"] }),
        { ok: true, value: ["a", "b"] },
        "a well-formed id list passes through unchanged",
    );
    assert.deepEqual(
        coerceReorderInput({ order: [] }),
        { ok: true, value: [] },
        "an empty order is legal (nothing to reorder)",
    );

    // req.json() parses a literal `null` body, so the route's catch fallback never fires.
    assert.equal(coerceReorderInput(null).ok, false, "a null body rejects");
    assert.equal(
        coerceReorderInput({}).ok,
        false,
        "a missing order rejects",
    );
    assert.equal(
        coerceReorderInput({ order: "a,b" }).ok,
        false,
        "a string order rejects",
    );
    assert.equal(
        coerceReorderInput({ order: ["a", 7] }).ok,
        false,
        "a non-string entry rejects the whole list, never silently drops it",
    );

    const atCap = Array.from({ length: MAX_SET_IDS }, (_, i) => `id${i}`);
    assert.equal(
        coerceReorderInput({ order: atCap }).ok,
        true,
        "a list exactly at the cap passes",
    );
    assert.equal(
        coerceReorderInput({ order: [...atCap, "one-too-many"] }).ok,
        false,
        "one over the cap rejects rather than truncating",
    );
});
