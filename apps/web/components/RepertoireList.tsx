"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AssessedReadiness, KeySig } from "@repertoire/core";
import type { SongRow } from "@/lib/db";
import { formatArrangerCredit, formatKey, formatSeconds } from "@/lib/format";
import { ArchiveButton } from "@/components/ArchiveButton";
import { IntensityDots } from "@/components/IntensityDots";
import { RowMenu } from "@/components/RowMenu";
import { Pagination } from "@/components/Pagination";
import { usePagination } from "@/lib/usePagination";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// A song plus its precomputed part count, so the client list needs no db reads.
export type RepertoireItem = SongRow & { partCount: number };

type SortKey = "title" | "readiness" | "duration" | "rehearsed";
type StatusFilter = "active" | "archived" | "all";

const READINESS: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
    "learning",
    "dormant",
];

// Readiness → the status dot's colour band + short label. The four bands map to the
// design tokens: ready=teal, polishing=amber, learning=clay, dormant=faint.
const STATUS: Record<AssessedReadiness, { label: string; variant: string }> = {
    "performance-ready": { label: "Ready", variant: "ready" },
    "needs-polish": { label: "Polishing", variant: "polish" },
    learning: { label: "Learning", variant: "learning" },
    dormant: { label: "Dormant", variant: "dormant" },
};

// Compact key for the mono column: "G maj", "A min", "Eb maj→G maj" on a modulation.
function keyCell(start: KeySig | null, end: KeySig | null): string {
    if (!start) return "—";
    const short = (k: KeySig) =>
        formatKey(k).replace(" major", " maj").replace(" minor", " min");
    const head = short(start);
    if (end && (end.fifths !== start.fifths || end.mode !== start.mode))
        return `${head}→${short(end)}`;
    return head;
}

// Opening tempo (free when none); a tempo change shows the range.
function tempoCell(song: SongRow): string {
    if (song.startTempoBpm == null) return "free";
    const { startTempoBpm: s, endTempoBpm: e } = song;
    return e != null && e !== s ? `${s}–${e}` : `${s}`;
}

function Row({ song }: { song: RepertoireItem }) {
    const prefix = useEnsemblePrefix();
    const st = STATUS[song.assessedReadiness] ?? {
        label: song.assessedReadiness,
        variant: "dormant",
    };
    const archived = song.status === "archived";
    // Dormant songs dim (a design signal); archived songs dim harder + strike the title.
    const rowClass = archived
        ? "song-archived"
        : song.assessedReadiness === "dormant"
          ? "song-dormant"
          : undefined;
    const arrangerCredit = formatArrangerCredit(song.arranger);

    return (
        <tr className={rowClass}>
            <td className="cell-title">
                <div className="song-name-line">
                    <Link
                        href={`${prefix}/repertoire/${song.publicId}`}
                        className="song-name"
                    >
                        {song.title}
                    </Link>
                    {archived && (
                        <span className="song-flag archived">archived</span>
                    )}
                    {song.isExplicit && (
                        <span className="song-flag explicit">explicit</span>
                    )}
                    {song.bookStatus === "on-book" && (
                        <span className="song-flag book">on-book</span>
                    )}
                </div>
                {arrangerCredit && (
                    <span className="cell-sub">{arrangerCredit}</span>
                )}
            </td>
            <td className="cell-key">{keyCell(song.startKey, song.endKey)}</td>
            <td className="cell-mono">{tempoCell(song)}</td>
            <td className="cell-mono">
                {song.durationSeconds != null
                    ? formatSeconds(song.durationSeconds)
                    : "—"}
            </td>
            <td className="cell-int">
                <IntensityDots value={song.intensity} />
            </td>
            <td className="cell-tags">
                {song.tags.length > 0
                    ? song.tags.map((t) => t.name).join(", ")
                    : "—"}
            </td>
            <td className="cell-status">
                <span className={`song-status ${st.variant}`}>
                    <span className={`song-dot ${st.variant}`} />
                    {st.label}
                </span>
            </td>
            <td className="cell-actions">
                <RowMenu label={`Actions for ${song.title}`}>
                    {(close) => (
                        <>
                            <Link
                                href={`${prefix}/repertoire/${song.publicId}`}
                                className="row-menu-item"
                                onClick={close}
                            >
                                Edit
                            </Link>
                            <Link
                                href={`${prefix}/repertoire/${song.publicId}/casting`}
                                className="row-menu-item"
                                onClick={close}
                            >
                                Cast
                            </Link>
                            <ArchiveButton
                                id={song.id}
                                active={song.status === "active"}
                                resource="songs"
                                variant="menuitem"
                                onActed={close}
                            />
                        </>
                    )}
                </RowMenu>
            </td>
        </tr>
    );
}

// Client-side search, tag-chip filter, and sort over the repertoire. The server passes the
// full book (one ensemble's songs, small enough to filter in the browser); no round-trip
// per keystroke. Tag chips are multi-select and OR together (a song matches any chosen tag).
export function RepertoireList({
    items,
    tags,
}: {
    items: RepertoireItem[];
    tags: string[];
}) {
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortKey>("title");
    const [status, setStatus] = useState<StatusFilter>("active");
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
    const prefix = useEnsemblePrefix();

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
            if (status !== "all" && s.status !== status) return false;
            if (
                activeTags.size > 0 &&
                !s.tags.some((t) => activeTags.has(t.name))
            )
                return false;
            if (needle) {
                const hay = [
                    s.title,
                    s.arranger ?? "",
                    ...s.tags.map((t) => t.name),
                ]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });

        const byTitle = (a: RepertoireItem, b: RepertoireItem) =>
            a.title.localeCompare(b.title);
        const cmp = (a: RepertoireItem, b: RepertoireItem): number => {
            if (sort === "readiness") {
                return (
                    READINESS.indexOf(a.assessedReadiness) -
                        READINESS.indexOf(b.assessedReadiness) || byTitle(a, b)
                );
            }
            if (sort === "duration") {
                return (
                    (a.durationSeconds ?? Infinity) -
                        (b.durationSeconds ?? Infinity) || byTitle(a, b)
                );
            }
            if (sort === "rehearsed") {
                // Most recently rehearsed first; never-rehearsed (null) sort last.
                return (
                    (b.lastRehearsed ?? "").localeCompare(
                        a.lastRehearsed ?? "",
                    ) || byTitle(a, b)
                );
            }
            return byTitle(a, b);
        };
        return [...rows].sort(cmp);
    }, [items, query, sort, status, activeTags]);

    // Paginate the filtered result. The resetKey ties the current page to the filter/sort state, so
    // changing any of them returns to page 1 instead of stranding the reader on a now-empty page.
    const resetKey = `${query}|${sort}|${status}|${[...activeTags].sort().join(",")}`;
    const pager = usePagination(shown, { resetKey });

    // Day one the book is empty. Drop the search / sort / status toolbar (noise over nothing) and
    // put the real "add a song" action inside the dashed card, with a static readiness legend as a
    // preview of what fills in. A filtered-to-nothing result still shows the toolbar below.
    if (items.length === 0) {
        return (
            <div className="empty">
                <p>
                    Your book is empty. Add the songs your group sings, with
                    their key, tempo, and length, and the drafter can start
                    building sets.
                </p>
                <Link href={`${prefix}/repertoire/new`} className="empty-cta">
                    Add your first song →
                </Link>
                <div className="readiness-legend empty-legend">
                    <span className="leg-ready">Ready</span> ·{" "}
                    <span className="leg-polishing">Polishing</span> ·{" "}
                    <span className="leg-learning">Learning</span>
                </div>
            </div>
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
                        <option value="rehearsed">Sort: Last rehearsed</option>
                    </select>
                    <select
                        className="songs-select"
                        value={status}
                        onChange={(e) =>
                            setStatus(e.target.value as StatusFilter)
                        }
                        aria-label="Status"
                    >
                        <option value="active">Active</option>
                        <option value="archived">Archived</option>
                        <option value="all">All statuses</option>
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
                            <table className="hub-table songs-table">
                                <thead>
                                    <tr>
                                        <th>Title</th>
                                        <th>Key</th>
                                        <th>Tempo</th>
                                        <th>Length</th>
                                        <th>Intensity</th>
                                        <th>Tags</th>
                                        <th>Status</th>
                                        <th
                                            className="th-actions"
                                            aria-label="Actions"
                                        />
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
