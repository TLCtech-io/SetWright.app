"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// One event's presentation data, derived server-side (status + RSVP are computed there) so the
// client list is pure filter + sort with no db reads. eventDate is the ISO date, kept alongside
// its label for sorting and the upcoming/past split.
export type EventListRow = {
    id: string; // the event uuid: React key only, never a URL
    publicId: string; // the event URL token, for the detail link
    name: string;
    kind: "gig" | "rehearsal";
    eventDate: string | null;
    dateLabel: string;
    venue: string | null;
    targetLabel: string;
    allowsOnBook: boolean;
    cancelled: boolean;
    rsvpLabel: string;
    rsvpZero: boolean;
    statusLabel: string;
    statusKlass: string;
};

type SortKey = "date" | "name" | "status";
type Filter = "all" | "upcoming" | "awaiting" | "performed" | "cancelled";

// Sort-by-status order: what needs the director's attention first, done last.
const STATUS_ORDER: Record<string, number> = {
    "Awaiting RSVPs": 0,
    Drafting: 1,
    Finalized: 2,
    Performed: 3,
    Cancelled: 4,
};

// Client-side search, filter, and sort over the events list. The server passes the full list
// (one ensemble's events, small enough to filter in the browser) plus "today" in the ensemble's
// timezone, so the upcoming/past split matches the rest of the app. Reuses the shared list-toolbar
// styles (currently the .songs-* classes).
export function EventsList({
    rows,
    today,
}: {
    rows: EventListRow[];
    today: string;
}) {
    const prefix = useEnsemblePrefix();
    const [tab, setTab] = useState<"gig" | "rehearsal">("gig");
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortKey>("date");
    const [filter, setFilter] = useState<Filter>("all");

    const counts = useMemo(
        () => ({
            gig: rows.filter((r) => r.kind === "gig").length,
            rehearsal: rows.filter((r) => r.kind === "rehearsal").length,
        }),
        [rows],
    );

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = rows.filter((r) => {
            if (r.kind !== tab) return false;
            if (
                filter === "upcoming" &&
                !(r.eventDate != null && r.eventDate >= today && !r.cancelled)
            )
                return false;
            if (filter === "awaiting" && r.statusLabel !== "Awaiting RSVPs")
                return false;
            if (
                filter === "performed" &&
                !(
                    r.statusLabel === "Performed" ||
                    r.statusLabel === "Finalized"
                )
            )
                return false;
            if (filter === "cancelled" && !r.cancelled) return false;
            if (
                needle &&
                !`${r.name} ${r.venue ?? ""}`.toLowerCase().includes(needle)
            )
                return false;
            return true;
        });

        const byName = (a: EventListRow, b: EventListRow) =>
            a.name.localeCompare(b.name);
        // Date: upcoming (>= today) soonest first, then past most-recent first, undated last.
        const byDate = (a: EventListRow, b: EventListRow): number => {
            if (a.eventDate == null || b.eventDate == null) {
                return a.eventDate == null
                    ? b.eventDate == null
                        ? byName(a, b)
                        : 1
                    : -1;
            }
            const au = a.eventDate >= today;
            const bu = b.eventDate >= today;
            if (au !== bu) return au ? -1 : 1;
            return au
                ? a.eventDate.localeCompare(b.eventDate)
                : b.eventDate.localeCompare(a.eventDate);
        };
        const cmp = (a: EventListRow, b: EventListRow): number => {
            if (sort === "name") return byName(a, b);
            if (sort === "status") {
                return (
                    (STATUS_ORDER[a.statusLabel] ?? 9) -
                        (STATUS_ORDER[b.statusLabel] ?? 9) || byDate(a, b)
                );
            }
            return byDate(a, b);
        };
        return [...filtered].sort(cmp);
    }, [rows, query, sort, filter, today, tab]);

    return (
        <>
            <div className="tabs" role="tablist" aria-label="Event kind">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "gig"}
                    className={`tab${tab === "gig" ? " on" : ""}`}
                    onClick={() => setTab("gig")}
                >
                    Gigs <span className="tab-count">{counts.gig}</span>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "rehearsal"}
                    className={`tab${tab === "rehearsal" ? " on" : ""}`}
                    onClick={() => setTab("rehearsal")}
                >
                    Rehearsals{" "}
                    <span className="tab-count">{counts.rehearsal}</span>
                </button>
            </div>

            {counts[tab] > 0 && (
                <>
                    <div className="songs-toolbar">
                        <input
                            className="songs-search"
                            type="text"
                            placeholder="Search events, venues…"
                            aria-label="Search events"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        <div className="songs-controls">
                            <select
                                className="songs-select"
                                value={sort}
                                onChange={(e) =>
                                    setSort(e.target.value as SortKey)
                                }
                                aria-label="Sort by"
                            >
                                <option value="date">Sort: Date</option>
                                <option value="name">Sort: Name</option>
                                <option value="status">Sort: Status</option>
                            </select>
                            <select
                                className="songs-select"
                                value={filter}
                                onChange={(e) =>
                                    setFilter(e.target.value as Filter)
                                }
                                aria-label="Filter events"
                            >
                                <option value="all">All events</option>
                                <option value="upcoming">Upcoming</option>
                                <option value="awaiting">Awaiting RSVPs</option>
                                <option value="performed">Performed</option>
                                <option value="cancelled">Cancelled</option>
                            </select>
                        </div>
                    </div>

                    <p
                        className="songs-count"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        {shown.length} of {counts[tab]}{" "}
                        {tab === "rehearsal" ? "rehearsal" : "gig"}
                        {counts[tab] === 1 ? "" : "s"}
                    </p>
                </>
            )}

            {counts[tab] === 0 ? (
                <div className="empty">
                    <p>
                        {tab === "rehearsal"
                            ? "No rehearsals on the calendar yet. Add one and set its date and who you need."
                            : "No gigs on the calendar yet. Add one and set its date, length, and who you need, then draft a set for it."}
                    </p>
                    <Link
                        href={
                            tab === "rehearsal"
                                ? `${prefix}/events/new?kind=rehearsal`
                                : `${prefix}/events/new`
                        }
                        className="empty-cta"
                    >
                        {tab === "rehearsal"
                            ? "Create your first rehearsal →"
                            : "Create your first event →"}
                    </Link>
                </div>
            ) : shown.length === 0 ? (
                <p className="songs-empty">{`No ${tab === "rehearsal" ? "rehearsals" : "gigs"} match.`}</p>
            ) : (
                <div className="hub-table-card">
                    <div className="hub-table-scroll">
                        <table className="hub-table">
                            <thead>
                                <tr>
                                    <th>Event</th>
                                    <th>Venue</th>
                                    <th>Target</th>
                                    <th>Policy</th>
                                    <th>RSVP</th>
                                    <th className="cell-right">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((e) => (
                                    <tr
                                        key={e.id}
                                        className={
                                            e.cancelled
                                                ? "cancelled"
                                                : undefined
                                        }
                                    >
                                        <td className="cell-title">
                                            <Link
                                                href={`${prefix}/events/${e.publicId}`}
                                            >
                                                {e.name}
                                            </Link>
                                            <span className="cell-sub">
                                                {e.dateLabel}
                                            </span>
                                        </td>
                                        <td className="cell-mono">
                                            {e.venue ?? "—"}
                                        </td>
                                        <td className="cell-mono">
                                            {e.targetLabel}
                                        </td>
                                        <td>
                                            {e.cancelled ? (
                                                <span className="cell-mono">
                                                    —
                                                </span>
                                            ) : (
                                                <span
                                                    className={`epill ${e.allowsOnBook ? "good" : "neutral"}`}
                                                >
                                                    {e.allowsOnBook
                                                        ? "Book"
                                                        : "Off-book"}
                                                </span>
                                            )}
                                        </td>
                                        <td
                                            className={`cell-mono${e.rsvpZero ? " zero" : ""}`}
                                        >
                                            {e.rsvpLabel}
                                        </td>
                                        <td className="cell-right">
                                            <span
                                                className={`epill ${e.statusKlass}`}
                                            >
                                                {e.statusLabel}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </>
    );
}
