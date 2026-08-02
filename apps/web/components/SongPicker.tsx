"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { AssessedReadiness } from "@repertoire/core";
import { formatEventDate } from "@/lib/format";
import { Pagination } from "@/components/Pagination";
import { usePagination } from "@/lib/usePagination";
import {
    orderPickerRows,
    type PickerRow,
    type PickerSortKey,
} from "@/lib/pickerRows";

// One filterable, sortable, paginated view of the book, with an Add per row. Shared by the
// rehearsal agenda and the gig prep panel: the whole book lives in this one list, so neither
// surface needs a separate "add another song" dropdown. Consumers pass already-eligible songs
// (those not yet chosen) plus per-row badges; ranked lists get a "Most needed" sort. The
// filter/sort itself lives in lib/pickerRows so it can be unit-tested apart from React.

export interface PickerSong extends PickerRow {
    badges?: ReactNode; // per-row badges (suggestion reasons, run flag, undercast)
}

const READINESS: Record<AssessedReadiness, { label: string; variant: string }> =
    {
        "performance-ready": { label: "Ready", variant: "ready" },
        "needs-polish": { label: "Polishing", variant: "polish" },
        learning: { label: "Learning", variant: "learning" },
        dormant: { label: "Dormant", variant: "dormant" },
    };

export function SongPicker({
    songs,
    onAdd,
    ranked = false,
    facet,
    unit = "Songs",
    emptyLabel = "The whole book is already here.",
}: {
    songs: PickerSong[];
    onAdd: (id: string) => void;
    ranked?: boolean; // show and default to the "Most needed" sort
    facet?: { label: string; options: string[] }; // one extra select, e.g. { label: 'upcoming gig', options }
    unit?: string;
    emptyLabel?: string; // shown when there is nothing left to add
}) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<PickerSortKey>(
        ranked ? "needed" : "title",
    );
    const [facetChoice, setFacetChoice] = useState(""); // '' = all, '__any__' = any facet value, else a value
    const [theseFirst, setTheseFirst] = useState(false); // float the chosen facet's songs to the top instead of hiding the rest
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

    const tagUniverse = useMemo(
        () => [...new Set(songs.flatMap((s) => s.tags))].sort(),
        [songs],
    );

    const toggleTag = (t: string) =>
        setActiveTags((prev) => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t);
            else next.add(t);
            return next;
        });

    const shown = useMemo(
        () =>
            orderPickerRows(songs, {
                query,
                sort,
                facetChoice,
                theseFirst,
                activeTags,
            }),
        [songs, query, sort, facetChoice, activeTags, theseFirst],
    );

    const resetKey = `${query}|${sort}|${facetChoice}|${theseFirst}|${[...activeTags].sort().join(",")}`;
    const pager = usePagination(shown, { resetKey });

    if (songs.length === 0) {
        return <p className="picker-empty">{emptyLabel}</p>;
    }

    return (
        <div className="picker">
            <div className="songs-toolbar">
                <input
                    className="songs-search"
                    type="text"
                    placeholder="Search songs, tags…"
                    aria-label="Search songs to add"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <div className="songs-controls">
                    <select
                        className="songs-select"
                        value={sort}
                        onChange={(e) =>
                            setSort(e.target.value as PickerSortKey)
                        }
                        aria-label="Sort by"
                    >
                        {ranked && (
                            <option value="needed">Sort: Most needed</option>
                        )}
                        <option value="title">Sort: Title</option>
                        <option value="readiness">Sort: Readiness</option>
                        <option value="rehearsed">Sort: Last rehearsed</option>
                        <option value="duration">Sort: Length</option>
                    </select>
                    {facet && (
                        <select
                            className="songs-select"
                            value={facetChoice}
                            onChange={(e) => setFacetChoice(e.target.value)}
                            aria-label={`Filter by ${facet.label}`}
                        >
                            <option value="">All songs</option>
                            <option value="__any__">Any {facet.label}</option>
                            {facet.options.map((o) => (
                                <option key={o} value={o}>
                                    {o}
                                </option>
                            ))}
                        </select>
                    )}
                    {facet && facetChoice !== "" && (
                        <button
                            type="button"
                            className={`songs-toggle${theseFirst ? " on" : ""}`}
                            aria-pressed={theseFirst}
                            onClick={() => setTheseFirst((v) => !v)}
                            title={`Keep the whole book, with this ${facet.label}'s songs on top`}
                        >
                            These first
                        </button>
                    )}
                </div>
                {tagUniverse.length > 0 && (
                    <div
                        className="filter-chips"
                        role="group"
                        aria-label="Filter by tag"
                    >
                        {tagUniverse.map((t) => {
                            const on = activeTags.has(t);
                            return (
                                <button
                                    key={t}
                                    type="button"
                                    className={`filter-chip${on ? " on" : ""}`}
                                    aria-pressed={on}
                                    onClick={() => toggleTag(t)}
                                >
                                    {t}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <p
                className="songs-count"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {shown.length} of {songs.length} to add
            </p>

            {shown.length === 0 ? (
                <p className="picker-empty">No songs match.</p>
            ) : (
                <>
                    <ul className="picker-list">
                        {pager.pageItems.map((s) => {
                            const st = READINESS[s.readiness];
                            return (
                                <li key={s.id} className="picker-row">
                                    <div className="picker-main">
                                        <span className="picker-title">
                                            {s.title}
                                        </span>
                                        {s.badges && (
                                            <div className="picker-badges">
                                                {s.badges}
                                            </div>
                                        )}
                                    </div>
                                    <span
                                        className={`song-status ${st.variant}`}
                                    >
                                        <span
                                            className={`song-dot ${st.variant}`}
                                        />
                                        {st.label}
                                    </span>
                                    <span className="picker-last">
                                        {s.lastRehearsed
                                            ? formatEventDate(s.lastRehearsed)
                                            : "never run"}
                                    </span>
                                    <button
                                        type="button"
                                        className="ctl picker-add"
                                        onClick={() => onAdd(s.id)}
                                    >
                                        Add
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {shown.length > Math.min(...pager.sizes) && (
                        <Pagination state={pager} unit={unit} />
                    )}
                </>
            )}
        </div>
    );
}
