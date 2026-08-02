// The SongPicker's filter-then-sort, extracted from the component so it is pure and testable.
// The component's PickerSong adds display-only extras (React badges); this row shape carries
// only what the picker filters and sorts on, so the logic stays free of React.

import type { AssessedReadiness } from "@repertoire/core";

export interface PickerRow {
    id: string;
    title: string;
    readiness: AssessedReadiness;
    lastRehearsed: string | null;
    durationSeconds: number | null;
    tags: string[];
    rank?: number | null; // ranking position (0 = most needed); only used when ranked
    facetValues?: string[]; // values this song matches for the optional facet (e.g. gig names)
}

export type PickerSortKey =
    | "needed"
    | "title"
    | "readiness"
    | "rehearsed"
    | "duration";

export const READINESS_ORDER: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
    "learning",
    "dormant",
];

const byTitle = (a: PickerRow, b: PickerRow): number =>
    a.title.localeCompare(b.title);

export interface PickerControls {
    query: string;
    sort: PickerSortKey;
    facetChoice: string; // '' = all, '__any__' = any facet value, else a specific facet value
    theseFirst: boolean; // float the chosen facet's songs to the top and keep the whole book
    activeTags: ReadonlySet<string>;
}

// Filter (search + tags + optional facet) then sort. "These first" floats the chosen facet's
// songs to the top and keeps the whole book; otherwise the facet hides everything that does not
// match. A title tiebreak keeps every sort deterministic.
export function orderPickerRows<T extends PickerRow>(
    songs: readonly T[],
    c: PickerControls,
): T[] {
    const needle = c.query.trim().toLowerCase();
    const floating = c.theseFirst && c.facetChoice !== "";
    const matchesFacet = (s: PickerRow): boolean =>
        c.facetChoice === "__any__"
            ? !!s.facetValues && s.facetValues.length > 0
            : !!s.facetValues?.includes(c.facetChoice);

    const rows = songs.filter((s) => {
        if (c.activeTags.size > 0 && !s.tags.some((t) => c.activeTags.has(t)))
            return false;
        if (c.facetChoice && !floating && !matchesFacet(s)) return false;
        if (needle) {
            const hay = [s.title, ...s.tags].join(" ").toLowerCase();
            if (!hay.includes(needle)) return false;
        }
        return true;
    });

    const cmp = (a: T, b: T): number => {
        if (floating) {
            const gap = (matchesFacet(a) ? 0 : 1) - (matchesFacet(b) ? 0 : 1);
            if (gap !== 0) return gap;
        }
        if (c.sort === "needed")
            return (a.rank ?? Infinity) - (b.rank ?? Infinity) || byTitle(a, b);
        if (c.sort === "readiness")
            return (
                READINESS_ORDER.indexOf(a.readiness) -
                    READINESS_ORDER.indexOf(b.readiness) || byTitle(a, b)
            );
        if (c.sort === "duration")
            return (
                (a.durationSeconds ?? Infinity) -
                    (b.durationSeconds ?? Infinity) || byTitle(a, b)
            );
        if (c.sort === "rehearsed")
            return (
                (b.lastRehearsed ?? "").localeCompare(a.lastRehearsed ?? "") ||
                byTitle(a, b)
            );
        return byTitle(a, b);
    };
    return [...rows].sort(cmp);
}
