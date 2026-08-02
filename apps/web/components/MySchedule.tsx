"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { AvailabilityStatus } from "@repertoire/core";
import type { AttendanceGroup } from "@/lib/attendanceGroups";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

export interface MyEventRsvp {
    id: string; // the event uuid: React key + the RSVP write path, never a URL
    publicId: string; // the event URL token, for the call-sheet link
    name: string;
    kind: "gig" | "rehearsal";
    date: string | null; // ISO, for sorting
    dateLabel: string; // display, e.g. "Wed Jul 15" or "Date TBD"
    status: AvailabilityStatus | null;
    cancelled: boolean;
    venue: string | null;
    eventType: string | null; // the event type name, when one applies
    targetLabel: string | null; // formatted target length, null when unset
    allowsOnBook: boolean;
    allowsExplicit: boolean;
    groups: AttendanceGroup[]; // who is coming, by section (names only)
}

const OPTIONS: { value: AvailabilityStatus; label: string }[] = [
    { value: "in", label: "In" },
    { value: "tentative", label: "Maybe" },
    { value: "out", label: "Out" },
];

type SchedSort = "date" | "name" | "status";
type SchedFilter = "all" | "unanswered" | "in" | "tentative" | "out";
// Status order for the sort: not-responded first (needs action), then maybe, out, in.
const STATUS_RANK: Record<AvailabilityStatus, number> = {
    tentative: 1,
    out: 2,
    in: 3,
};
const statusRank = (s: AvailabilityStatus | null) =>
    s == null ? 0 : STATUS_RANK[s];

// One "who's coming" line for a section's answer bucket, omitted when the bucket is empty.
function Bucket({
    label,
    names,
    tone,
}: {
    label: string;
    names: string[];
    tone: string;
}) {
    if (names.length === 0) return null;
    return (
        <span className={`wc-bucket wc-${tone}`}>
            <span className="wc-bucket-label">{label}</span> {names.join(", ")}
        </span>
    );
}

// The member's own RSVP per event: three buttons, the current one highlighted. Each click
// writes the single row (PUT .../rsvp -> set_my_availability) optimistically, rolling back
// on failure. No version token — a self-write replaces nothing but the member's own row.
// Each row carries the event's context (venue, type, target, on-book/explicit) and an
// expandable "who's coming" by section. Cancelled events are struck, not hidden, so a member
// sees the change; they carry no RSVP.
//
// In-flight writes are tracked PER event id (not a single slot), and re-entrancy is blocked
// with an early return rather than by disabling the just-clicked button: disabling the
// focused control would yank keyboard/AT focus to <body>. Errors are per row too, so one
// row's success never clears another's error.
export function MySchedule({
    events,
    today,
}: {
    events: MyEventRsvp[];
    today: string;
}) {
    const prefix = useEnsemblePrefix();
    const [state, setState] = useState<
        Record<string, AvailabilityStatus | null>
    >(Object.fromEntries(events.map((e) => [e.id, e.status])));
    const [inflight, setInflight] = useState<Set<string>>(new Set());
    const [failed, setFailed] = useState<Set<string>>(new Set());
    const [open, setOpen] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SchedSort>("date");
    const [filter, setFilter] = useState<SchedFilter>("all");

    const without = (s: Set<string>, id: string) => {
        const n = new Set(s);
        n.delete(id);
        return n;
    };

    const toggle = (id: string) =>
        setOpen((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    async function setStatus(eventId: string, status: AvailabilityStatus) {
        if (inflight.has(eventId)) return; // block double-submit without disabling the focused control
        const prev = state[eventId] ?? null;
        setInflight((s) => new Set(s).add(eventId));
        setFailed((s) => without(s, eventId));
        setState((s) => ({ ...s, [eventId]: status }));
        let ok = false;
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/rsvp`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status }),
            });
            ok = res.ok;
        } catch {
            ok = false;
        }
        setInflight((s) => without(s, eventId));
        if (!ok) {
            setState((s) => ({ ...s, [eventId]: prev }));
            setFailed((s) => new Set(s).add(eventId));
        }
    }

    // Client-side search, filter, and sort. Filter and sort read the initial RSVP from props, not
    // the live edit state, so answering an event never reorders or drops its row from under the
    // cursor — the row stays put (its buttons just update) and refreshes on the next load.
    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = events.filter((e) => {
            // A cancelled event carries no live RSVP, so it only belongs under "all", never a status filter.
            if (e.cancelled && filter !== "all") return false;
            if (filter === "unanswered" && e.status != null) return false;
            if (
                filter !== "all" &&
                filter !== "unanswered" &&
                e.status !== filter
            )
                return false;
            if (
                needle &&
                !`${e.name} ${e.venue ?? ""}`.toLowerCase().includes(needle)
            )
                return false;
            return true;
        });
        const byName = (a: MyEventRsvp, b: MyEventRsvp) =>
            a.name.localeCompare(b.name);
        // Upcoming first (soonest at the top, the events a member still needs to RSVP to), then past
        // events most-recent first; undated last. today is the ensemble's day boundary.
        const byDate = (a: MyEventRsvp, b: MyEventRsvp) => {
            if (a.date == null || b.date == null)
                return a.date == null
                    ? b.date == null
                        ? byName(a, b)
                        : 1
                    : -1;
            const aUp = a.date >= today;
            const bUp = b.date >= today;
            if (aUp !== bUp) return aUp ? -1 : 1;
            return (
                (aUp
                    ? a.date.localeCompare(b.date)
                    : b.date.localeCompare(a.date)) || byName(a, b)
            );
        };
        return [...filtered].sort((a, b) => {
            if (sort === "name") return byName(a, b);
            if (sort === "status")
                return (
                    statusRank(a.status) - statusRank(b.status) || byDate(a, b)
                );
            return byDate(a, b);
        });
    }, [events, query, sort, filter]);

    return (
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
                        onChange={(e) => setSort(e.target.value as SchedSort)}
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
                            setFilter(e.target.value as SchedFilter)
                        }
                        aria-label="Filter events"
                    >
                        <option value="all">All events</option>
                        <option value="unanswered">Not responded</option>
                        <option value="in">In</option>
                        <option value="tentative">Maybe</option>
                        <option value="out">Out</option>
                    </select>
                </div>
            </div>

            <p
                className="songs-count"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {shown.length} of {events.length} event
                {events.length === 1 ? "" : "s"}
            </p>

            {shown.length === 0 ? (
                <p className="songs-empty">No events match.</p>
            ) : (
                <div className="rep-list">
                    {shown.map((e) => {
                        const meta = [
                            e.dateLabel,
                            e.venue,
                            e.eventType,
                            e.targetLabel,
                        ]
                            .filter(Boolean)
                            .join(" · ");
                        const isOpen = open.has(e.id);
                        const wcId = `whoscoming-${e.id}`;
                        const inCount = e.groups.reduce(
                            (n, g) => n + g.in.length,
                            0,
                        );
                        return (
                            <div
                                key={e.id}
                                className={`sched-item${e.cancelled ? " cancelled" : ""}`}
                            >
                                <div
                                    className="rep-row"
                                    aria-busy={inflight.has(e.id)}
                                >
                                    <div className="rep-body">
                                        <div className="rep-title">
                                            {/* The name opens the event's call sheet: the running order the
                          director shared, who's coming, and the member's own parts for the night. */}
                                            <Link
                                                href={`${prefix}/events/${e.publicId}`}
                                                className="sched-name sched-name-link"
                                            >
                                                {e.name}
                                            </Link>
                                            {e.kind === "rehearsal" && (
                                                <span className="role-tag">
                                                    rehearsal
                                                </span>
                                            )}
                                            {e.cancelled && (
                                                <span className="role-tag pending">
                                                    cancelled
                                                </span>
                                            )}
                                        </div>
                                        <div className="rep-meta">
                                            {meta}
                                            {failed.has(e.id) && (
                                                <span
                                                    className="row-error"
                                                    role="alert"
                                                >
                                                    {" "}
                                                    · couldn&rsquo;t save, try
                                                    again
                                                </span>
                                            )}
                                        </div>
                                        {!e.cancelled && (
                                            <div className="sched-chips">
                                                <span
                                                    className={`epill ${e.allowsOnBook ? "good" : "neutral"}`}
                                                >
                                                    {e.allowsOnBook
                                                        ? "On book"
                                                        : "Off book"}
                                                </span>
                                                {e.allowsExplicit && (
                                                    <span className="epill neutral">
                                                        Explicit OK
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    {!e.cancelled && (
                                        <div
                                            className="rsvp-controls"
                                            role="group"
                                            aria-label={`Your RSVP for ${e.name}`}
                                        >
                                            {OPTIONS.map((o) => (
                                                <button
                                                    key={o.value}
                                                    type="button"
                                                    className={`rsvp-btn rsvp-${o.value}${state[e.id] === o.value ? " on" : ""}`}
                                                    aria-pressed={
                                                        state[e.id] === o.value
                                                    }
                                                    onClick={() =>
                                                        setStatus(e.id, o.value)
                                                    }
                                                >
                                                    {o.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {!e.cancelled && e.groups.length > 0 && (
                                    <>
                                        <button
                                            type="button"
                                            className="whoscoming-toggle"
                                            aria-expanded={isOpen}
                                            aria-controls={wcId}
                                            onClick={() => toggle(e.id)}
                                        >
                                            <span
                                                className="mypart-caret"
                                                aria-hidden="true"
                                            >
                                                ▸
                                            </span>
                                            Who&rsquo;s coming
                                            <span className="whoscoming-count">
                                                {inCount} in
                                            </span>
                                        </button>
                                        <div
                                            className={`reveal${isOpen ? " open" : ""}`}
                                        >
                                            <div className="reveal-inner">
                                                <div
                                                    className="whoscoming"
                                                    id={wcId}
                                                >
                                                    {e.groups.map((g) => (
                                                        <div
                                                            className="wc-group"
                                                            key={
                                                                g.sectionId ??
                                                                "unassigned"
                                                            }
                                                        >
                                                            <span className="wc-section">
                                                                {g.section}
                                                            </span>
                                                            <span className="wc-names">
                                                                <Bucket
                                                                    label="In"
                                                                    names={g.in}
                                                                    tone="in"
                                                                />
                                                                <Bucket
                                                                    label="Maybe"
                                                                    names={
                                                                        g.tentative
                                                                    }
                                                                    tone="tentative"
                                                                />
                                                                <Bucket
                                                                    label="Out"
                                                                    names={
                                                                        g.out
                                                                    }
                                                                    tone="out"
                                                                />
                                                                <Bucket
                                                                    label="No reply"
                                                                    names={
                                                                        g.pending
                                                                    }
                                                                    tone="pending"
                                                                />
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
