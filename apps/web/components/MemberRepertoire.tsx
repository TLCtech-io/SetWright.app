"use client";

import { useMemo, useState } from "react";
import type { AssessedReadiness, KeySig } from "@repertoire/core";
import {
    formatArrangerCredit,
    formatKeyRange,
    formatSeconds,
    formatTempo,
} from "@/lib/format";
import { IntensityDots } from "@/components/IntensityDots";
import { Pagination } from "@/components/Pagination";
import { usePagination } from "@/lib/usePagination";

// A member-safe projection of one active song. Built on the server (me/songs/page) from the fields a
// member may see about the book: no planning signals (last rehearsed/performed), no casting, no
// director-private assessment beyond the readiness the console already surfaces on /me/parts.
export interface MemberSong {
    id: string;
    title: string;
    arranger: string | null;
    chartRef: string | null;
    startKey: KeySig | null;
    endKey: KeySig | null;
    startTempoBpm: number | null;
    endTempoBpm: number | null;
    durationSeconds: number | null;
    intensity: number | null;
    isExplicit: boolean;
    onBook: boolean;
    assessedReadiness: AssessedReadiness;
    tags: string[];
}

type SortKey = "title" | "readiness" | "duration";

const READINESS_ORDER: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
    "learning",
    "dormant",
];
const STATUS: Record<AssessedReadiness, { label: string; variant: string }> = {
    "performance-ready": { label: "Ready", variant: "ready" },
    "needs-polish": { label: "Polishing", variant: "polish" },
    learning: { label: "Learning", variant: "learning" },
    dormant: { label: "Dormant", variant: "dormant" },
};

// The chart, when one is on file: a link for a URL, else a quiet marker carrying the reference as a
// title. Absent when there is no chart, so the cell degrades rather than guessing.
function ChartMark({ chartRef }: { chartRef: string | null }) {
    if (!chartRef) return null;
    if (/^https?:\/\//i.test(chartRef)) {
        return (
            <a
                className="song-chartlink"
                href={chartRef}
                target="_blank"
                rel="noopener noreferrer"
            >
                chart &#8599;
            </a>
        );
    }
    return (
        <span className="song-chartref" title={chartRef}>
            chart on file
        </span>
    );
}

function Row({ song }: { song: MemberSong }) {
    const st = STATUS[song.assessedReadiness] ?? {
        label: song.assessedReadiness,
        variant: "dormant",
    };
    const sub = formatArrangerCredit(song.arranger) ?? "";
    return (
        <tr
            className={
                song.assessedReadiness === "dormant"
                    ? "song-dormant"
                    : undefined
            }
        >
            <td className="cell-title">
                <div className="song-name-line">
                    <span className="song-name">{song.title}</span>
                    {song.isExplicit && (
                        <span className="song-flag explicit">explicit</span>
                    )}
                    {song.onBook && (
                        <span className="song-flag book">on-book</span>
                    )}
                </div>
                <span className="cell-sub">
                    {sub}
                    {sub && song.chartRef ? " · " : ""}
                    <ChartMark chartRef={song.chartRef} />
                </span>
            </td>
            <td className="cell-key" data-label="Key">
                {formatKeyRange(song.startKey, song.endKey)}
            </td>
            <td className="cell-mono" data-label="Tempo">
                {formatTempo(song.startTempoBpm, song.endTempoBpm)}
            </td>
            <td className="cell-mono" data-label="Length">
                {song.durationSeconds != null
                    ? formatSeconds(song.durationSeconds)
                    : "—"}
            </td>
            <td className="cell-int" data-label="Intensity">
                <IntensityDots value={song.intensity} />
            </td>
            <td className="cell-tags" data-label="Tags">
                {song.tags.length > 0 ? song.tags.join(", ") : "—"}
            </td>
            <td className="cell-status" data-label="Status">
                <span className={`song-status ${st.variant}`}>
                    <span className={`song-dot ${st.variant}`} />
                    {st.label}
                </span>
            </td>
        </tr>
    );
}

// The member's read-only browse of the active book: search, sort, and tag-chip filter over
// the songs the server projected to member-safe fields, then paginated. No row actions, no archived
// songs, no edit links — it imports no write control and shows nothing a member may not see.
export function MemberRepertoire({
    items,
    tags,
}: {
    items: MemberSong[];
    tags: string[];
}) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortKey>("title");
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

    const toggleTag = (t: string) =>
        setActiveTags((prev) => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t);
            else next.add(t);
            return next;
        });

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const rows = items.filter((s) => {
            if (activeTags.size > 0 && !s.tags.some((t) => activeTags.has(t)))
                return false;
            if (needle) {
                const hay = [s.title, s.arranger ?? "", ...s.tags]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
        const byTitle = (a: MemberSong, b: MemberSong) =>
            a.title.localeCompare(b.title);
        const cmp = (a: MemberSong, b: MemberSong): number => {
            if (sort === "readiness") {
                return (
                    READINESS_ORDER.indexOf(a.assessedReadiness) -
                        READINESS_ORDER.indexOf(b.assessedReadiness) ||
                    byTitle(a, b)
                );
            }
            if (sort === "duration") {
                return (
                    (a.durationSeconds ?? Infinity) -
                        (b.durationSeconds ?? Infinity) || byTitle(a, b)
                );
            }
            return byTitle(a, b);
        };
        return [...rows].sort(cmp);
    }, [items, query, sort, activeTags]);

    const resetKey = `${query}|${sort}|${[...activeTags].sort().join(",")}`;
    const pager = usePagination(shown, { resetKey });

    // Before the director adds any songs there is nothing to search or sort, so drop the toolbar and
    // explain what this space becomes. A filtered-to-nothing result still shows the toolbar below.
    if (items.length === 0) {
        return (
            <p className="empty">
                The book is empty for now. Once your director adds songs, you
                can browse the whole group&rsquo;s music here.
            </p>
        );
    }

    return (
        <>
            <div className="songs-toolbar">
                <input
                    className="songs-search"
                    type="text"
                    placeholder="Search songs, arrangers, tags…"
                    aria-label="Search songs"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <div className="songs-controls">
                    <select
                        className="songs-select"
                        value={sort}
                        onChange={(e) => setSort(e.target.value as SortKey)}
                        aria-label="Sort by"
                    >
                        <option value="title">Sort: Title</option>
                        <option value="readiness">Sort: Readiness</option>
                        <option value="duration">Sort: Length</option>
                    </select>
                </div>
                {tags.length > 0 && (
                    <div
                        className="filter-chips"
                        role="group"
                        aria-label="Filter by tag"
                    >
                        {tags.map((t) => {
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
                {shown.length} of {items.length} song
                {items.length === 1 ? "" : "s"}
            </p>

            {shown.length === 0 ? (
                <p className="songs-empty">No songs match.</p>
            ) : (
                <>
                    <div className="hub-table-card songs-card">
                        <div className="hub-table-scroll">
                            <table className="hub-table songs-table stack-mobile">
                                <thead>
                                    <tr>
                                        <th>Title</th>
                                        <th>Key</th>
                                        <th>Tempo</th>
                                        <th>Length</th>
                                        <th>Intensity</th>
                                        <th>Tags</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pager.pageItems.map((s) => (
                                        <Row key={s.id} song={s} />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    {shown.length > Math.min(...pager.sizes) && (
                        <Pagination state={pager} unit="Songs" />
                    )}
                </>
            )}
        </>
    );
}
