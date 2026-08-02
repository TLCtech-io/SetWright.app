// Run with: tsx test/unit/paging.test.ts
//
// pageAll is the loop behind selectAll: it pages a range-fetch to completion so a list read never
// stops at PostgREST's 1000-row cap. These assert it fetches every row and stops on a short page.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pageAll, PAGE_SIZE } from "../../lib/supabase/paging";

// A fetchPage over a fixed dataset that returns at most PAGE_SIZE rows per window, as PostgREST would.
function pager(total: number) {
    const data = Array.from({ length: total }, (_, i) => ({ i }));
    const windows: Array<[number, number]> = [];
    const fetchPage = async (
        from: number,
        to: number,
    ): Promise<Array<{ i: number }>> => {
        windows.push([from, to]);
        return data.slice(from, Math.min(to + 1, from + PAGE_SIZE));
    };
    return { windows, fetchPage };
}

test("pageAll: fetches every row past the cap and stops on a short page", async () => {
    const { fetchPage, windows } = pager(PAGE_SIZE * 2 + 5); // 2005
    const rows = await pageAll(fetchPage);
    assert.equal(
        rows.length,
        PAGE_SIZE * 2 + 5,
        "no rows dropped past the 1000-row cap",
    );
    assert.deepEqual(
        windows[0],
        [0, PAGE_SIZE - 1],
        "first window is [0, 999]",
    );
    assert.deepEqual(
        windows[1],
        [PAGE_SIZE, PAGE_SIZE * 2 - 1],
        "second window is [1000, 1999]",
    );
    assert.equal(windows.length, 3, "the short third page ends it");
});

test("pageAll: an exact multiple of the cap does one extra empty fetch, then stops", async () => {
    const { fetchPage, windows } = pager(PAGE_SIZE); // exactly 1000
    const rows = await pageAll(fetchPage);
    assert.equal(rows.length, PAGE_SIZE, "all rows returned");
    assert.equal(
        windows.length,
        2,
        "a full page forces one more fetch, which is empty and stops",
    );
});

test("pageAll: an empty first page returns nothing without looping", async () => {
    const { fetchPage, windows } = pager(0);
    const rows = await pageAll(fetchPage);
    assert.equal(rows.length, 0);
    assert.equal(windows.length, 1, "a single empty fetch stops it");
});
