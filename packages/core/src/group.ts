// Small grouping helpers. The drafter repeatedly needs to index a flat array by a
// foreign key: parts by their song, castings by their part. Keeping the loop in one
// place stops the five hand-rolled copies from drifting apart.

import type { Casting, ID, Part } from "./types.js";

/** Group items into a Map keyed by a derived key, preserving input order within each bucket. */
export function groupBy<T, K>(
    items: Iterable<T>,
    key: (item: T) => K,
): Map<K, T[]> {
    const out = new Map<K, T[]>();
    for (const item of items) {
        const k = key(item);
        const arr = out.get(k) ?? [];
        arr.push(item);
        out.set(k, arr);
    }
    return out;
}

/** Parts indexed by their song id. */
export function indexBySong(parts: Iterable<Part>): Map<ID, Part[]> {
    return groupBy(parts, (p) => p.songId);
}

/** Castings indexed by their part id. */
export function indexByPart(castings: Iterable<Casting>): Map<ID, Casting[]> {
    return groupBy(castings, (c) => c.partId);
}
