// Run with: tsx test/unit/pickerRows.test.ts
//
// The SongPicker's filter-then-sort, extracted from the component. Covers the facet's two
// modes: filter (hide the rest) and "these first" (float matches to the top, keep the whole
// book), plus how search, tags, and sort compose with each.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    orderPickerRows,
    type PickerRow,
    type PickerControls,
} from "../../lib/pickerRows";

const row = (
    id: string,
    title: string,
    extra: Partial<PickerRow> = {},
): PickerRow => ({
    id,
    title,
    readiness: "performance-ready",
    lastRehearsed: null,
    durationSeconds: null,
    tags: [],
    ...extra,
});

// A small book. Alpha + Charlie are prep for Gig X; Charlie + Delta for Gig Y; Bravo + Echo
// are prep for nothing. Echo carries a tag.
const book: PickerRow[] = [
    row("a", "Alpha", { facetValues: ["Gig X"], rank: 2 }),
    row("b", "Bravo"),
    row("c", "Charlie", { facetValues: ["Gig X", "Gig Y"], rank: 0 }),
    row("d", "Delta", { facetValues: ["Gig Y"] }),
    row("e", "Echo", { tags: ["ballad"] }),
];

const base: PickerControls = {
    query: "",
    sort: "title",
    facetChoice: "",
    theseFirst: false,
    activeTags: new Set(),
};
const ids = (rows: PickerRow[]) => rows.map((r) => r.id);

test("no facet: the whole book, title-sorted", () => {
    assert.deepEqual(ids(orderPickerRows(book, base)), [
        "a",
        "b",
        "c",
        "d",
        "e",
    ]);
});

test("facet filter hides everything that does not match", () => {
    assert.deepEqual(
        ids(orderPickerRows(book, { ...base, facetChoice: "Gig X" })),
        ["a", "c"],
    );
});

test('"these first" keeps the whole book with the facet matches floated to the top', () => {
    // Matches {Alpha, Charlie} first (title order), then the rest {Bravo, Delta, Echo}.
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                facetChoice: "Gig X",
                theseFirst: true,
            }),
        ),
        ["a", "c", "b", "d", "e"],
    );
});

test('"__any__" filters to songs that are prep for any facet value', () => {
    assert.deepEqual(
        ids(orderPickerRows(book, { ...base, facetChoice: "__any__" })),
        ["a", "c", "d"],
    );
});

test('"__any__" with "these first" floats every prep song to the top', () => {
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                facetChoice: "__any__",
                theseFirst: true,
            }),
        ),
        ["a", "c", "d", "b", "e"],
    );
});

test('"these first" is inert without a facet choice (whole book, unfloated)', () => {
    assert.deepEqual(
        ids(orderPickerRows(book, { ...base, theseFirst: true })),
        ["a", "b", "c", "d", "e"],
    );
});

test('search still prunes inside "these first"', () => {
    // "alph" matches only Alpha (search spans title + tags), so the float has nothing else to keep.
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                facetChoice: "Gig X",
                theseFirst: true,
                query: "alph",
            }),
        ),
        ["a"],
    );
});

test("tag filter still applies with the facet", () => {
    // Only Echo carries the ballad tag, and it is not a Gig X song, so filter mode yields nothing...
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                facetChoice: "Gig X",
                activeTags: new Set(["ballad"]),
            }),
        ),
        [],
    );
    // ...but "these first" keeps the tag-filtered book (just Echo), with no Gig X match to float.
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                facetChoice: "Gig X",
                theseFirst: true,
                activeTags: new Set(["ballad"]),
            }),
        ),
        ["e"],
    );
});

test('the "needed" sort orders by rank, floating still wins as the primary key', () => {
    // Plain "needed": Charlie (0), Alpha (2), then the unranked rest by title.
    assert.deepEqual(ids(orderPickerRows(book, { ...base, sort: "needed" })), [
        "c",
        "a",
        "b",
        "d",
        "e",
    ]);
    // With "these first" on Gig Y: matches {Charlie, Delta} float first (ranked among themselves:
    // Charlie 0, Delta unranked), then the rest by rank/title.
    assert.deepEqual(
        ids(
            orderPickerRows(book, {
                ...base,
                sort: "needed",
                facetChoice: "Gig Y",
                theseFirst: true,
            }),
        ),
        ["c", "d", "a", "b", "e"],
    );
});

test("the sort does not mutate the input array", () => {
    const input = [...book];
    orderPickerRows(input, {
        ...base,
        sort: "needed",
        facetChoice: "Gig X",
        theseFirst: true,
    });
    assert.deepEqual(ids(input), ["a", "b", "c", "d", "e"]);
});
