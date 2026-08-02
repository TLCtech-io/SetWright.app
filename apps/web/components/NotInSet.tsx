"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Drop, SetEntry } from "@repertoire/core";
import { songMeta } from "@/lib/format";

// One module for everything out of the set. It folds together three lists that
// were stacked separately — the bench (ready, over target), the songs you
// excluded, and the funnel's drops — because they are one question: what is not
// in the set, why, and how do I bring it back. Every row links to the song and
// carries a lever-shaped reason. Search spans all of it; the reason chips filter.
// Replaces CandidatesPanel + ExcludedPanel + DropsPanel.

type GroupKey =
    | "ready"
    | "gone-cold"
    | "excluded"
    | "not-coverable"
    | "below-readiness"
    | "wrong-fit"
    | "missing-data"
    | "over-cap";

type Action = "add" | "restore" | "keep";

interface Reserve {
    id: string;
    title: string;
    group: GroupKey;
    reason: string;
    meta: string | null; // key · tempo · length
    seconds: number; // padded time it would use / add — for worst-first sort
    action: Action;
}

// Group order runs closest-to-in first (a swap away) to furthest (failed a gate).
const GROUPS: { key: GroupKey; label: string; note: string }[] = [
    {
        key: "ready",
        label: "Ready to swap in",
        note: "Passed every gate, just over target",
    },
    {
        key: "gone-cold",
        label: "Gone cold",
        note: "Ready, but not rehearsed in 90+ days. Give it a run",
    },
    {
        key: "excluded",
        label: "You excluded",
        note: "Barred from this set. Restore to reconsider",
    },
    {
        key: "not-coverable",
        label: "Not coverable",
        note: "Short a part. Chase or recast to open",
    },
    {
        key: "below-readiness",
        label: "Below readiness",
        note: "Not performance-ready for this night",
    },
    {
        key: "wrong-fit",
        label: "Wrong fit",
        note: "Explicit, or carries an excluded tag",
    },
    {
        key: "missing-data",
        label: "Missing data",
        note: "No duration, so it cannot be placed",
    },
    {
        key: "over-cap",
        label: "Over set cap",
        note: "Past the sequencer size limit",
    },
];

const ACTION_LABEL: Record<Action, string> = {
    add: "Add",
    restore: "Restore",
    keep: "Keep anyway",
};

// The uncapped-view limit per group. A single-group filter lifts it.
const PREVIEW_LIMIT = 6;

// Turn a drop's (stage, detail) into a group and a lever-shaped reason.
function fromDrop(d: Drop): { group: GroupKey; reason: string } {
    switch (d.stage) {
        case "feasibility":
            return {
                group: "not-coverable",
                reason: d.detail ? `Short: ${d.detail}` : "Short a part",
            };
        case "readiness":
            return d.detail.includes("on-book")
                ? { group: "below-readiness", reason: "On-book only" }
                : {
                      group: "below-readiness",
                      reason: `Still ${d.detail.replace(" (below floor)", "")}`,
                  };
        case "context":
            if (d.detail === "explicit")
                return {
                    group: "wrong-fit",
                    reason: "Explicit for this audience",
                };
            if (d.detail === "accompaniment")
                return {
                    group: "wrong-fit",
                    reason: "Uses accompaniment, a cappella only",
                };
            return { group: "wrong-fit", reason: `Excluded tag: ${d.detail}` };
        case "data":
            return { group: "missing-data", reason: "No duration set" };
        case "capacity":
            return { group: "over-cap", reason: "Over the sequencer cap" };
        default:
            return { group: "over-cap", reason: d.detail };
    }
}

export function NotInSet({
    bench,
    excluded,
    drops,
    titleOf,
    metaOf,
    songToken,
    prefix,
    busy = false,
    onKeep,
    onRestore,
}: {
    bench: SetEntry[];
    excluded: string[];
    drops: Drop[];
    prefix: string;
    // Optional so a read-only caller (the draft preview, a Server Component) can
    // render the same module without passing functions across the client boundary.
    titleOf?: (id: string) => string;
    metaOf?: (id: string) => string | null;
    // Song uuid -> URL token. The reserve ids are song uuids (from core), so the deep link
    // needs the token. Absent -> fall back to the uuid (mock mode, where they coincide).
    songToken?: Map<string, string>;
    busy?: boolean;
    onKeep?: (id: string) => void;
    onRestore?: (id: string) => void;
}) {
    // No handlers means read-only: same grouped, searchable view, no recovery actions.
    const readOnly = !onKeep && !onRestore;
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<GroupKey | "all">("all");

    const items = useMemo<Reserve[]>(() => {
        const out: Reserve[] = [];
        for (const e of bench) {
            // A benched song gone cold (ready, but not rehearsed in 90+ days by the event
            // date) splits off into its own group so the director sees it needs a run, not
            // just that it is over target. The drafter flags it; here we only route it.
            out.push({
                id: e.song.id,
                title: e.song.title,
                group: e.stale ? "gone-cold" : "ready",
                reason: e.stale
                    ? "Ready, not rehearsed lately"
                    : "Ready, over target",
                meta: songMeta(e.song),
                seconds: e.stage,
                action: "add",
            });
        }
        for (const id of excluded) {
            out.push({
                id,
                title: titleOf ? titleOf(id) : id,
                group: "excluded",
                reason: "You excluded this",
                meta: metaOf ? metaOf(id) : null,
                seconds: 0,
                action: "restore",
            });
        }
        for (const d of drops) {
            const { group, reason } = fromDrop(d);
            out.push({
                id: d.song.id,
                title: d.song.title,
                group,
                reason,
                meta: songMeta(d.song),
                seconds: d.stageSeconds,
                action: "keep",
            });
        }
        return out;
    }, [bench, excluded, drops, titleOf, metaOf]);

    const total = items.length;

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return items.filter(
            (it) =>
                (filter === "all" || it.group === filter) &&
                (!q || it.title.toLowerCase().includes(q)),
        );
    }, [items, filter, query]);

    // Full-list counts per group, for the chips (unaffected by the active filter).
    const groupCounts = useMemo(() => {
        const m = new Map<GroupKey, number>();
        for (const it of items) m.set(it.group, (m.get(it.group) ?? 0) + 1);
        return m;
    }, [items]);

    if (total === 0) return null;

    const activeGroups = GROUPS.filter(
        (g) => (groupCounts.get(g.key) ?? 0) > 0,
    );

    return (
        <section className={`not-in-set${readOnly ? " readonly" : ""}`}>
            <div className="module-head">
                <h2 className="module-title">Not in the set</h2>
                <span className="module-count">{total} songs</span>
            </div>

            <div className="nis-controls">
                <input
                    type="search"
                    className="nis-search"
                    placeholder="Search songs not in the set…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <div className="nis-chips">
                    <button
                        type="button"
                        className={`chip-filter${filter === "all" ? " on" : ""}`}
                        onClick={() => setFilter("all")}
                    >
                        All {total}
                    </button>
                    {activeGroups.map((g) => (
                        <button
                            key={g.key}
                            type="button"
                            className={`chip-filter${filter === g.key ? " on" : ""}`}
                            onClick={() =>
                                setFilter((f) => (f === g.key ? "all" : g.key))
                            }
                        >
                            {g.label} {groupCounts.get(g.key)}
                        </button>
                    ))}
                </div>
            </div>

            {visible.length === 0 ? (
                <p className="nis-empty">
                    No songs match &ldquo;{query}&rdquo;.
                </p>
            ) : (
                activeGroups.map((g) => {
                    const rows = visible.filter((it) => it.group === g.key);
                    if (rows.length === 0) return null;
                    // Cap each group in the "all" view; a single-group filter shows everything.
                    const capped =
                        filter === "all" &&
                        !query &&
                        rows.length > PREVIEW_LIMIT;
                    const shown = capped ? rows.slice(0, PREVIEW_LIMIT) : rows;
                    return (
                        <div key={g.key} className="nis-group">
                            <div className="nis-group-head">
                                <span className="nis-group-label">
                                    {g.label}
                                </span>
                                <span className="nis-group-count">
                                    {groupCounts.get(g.key)}
                                </span>
                                <span className="nis-group-note">{g.note}</span>
                            </div>
                            <div className="nis-rows">
                                {shown.map((it) => (
                                    <div
                                        key={`${it.group}:${it.id}`}
                                        className="nis-row"
                                    >
                                        <Link
                                            href={`${prefix}/repertoire/${songToken?.get(it.id) ?? it.id}`}
                                            className="nis-title"
                                        >
                                            {it.title}
                                        </Link>
                                        <span className="nis-reason">
                                            {it.reason}
                                        </span>
                                        {/* Always rendered (empty when absent) so the shared column grid stays aligned. */}
                                        <span className="nis-meta">
                                            {it.meta ?? ""}
                                        </span>
                                        {!readOnly && (
                                            <button
                                                type="button"
                                                className="ctl"
                                                disabled={busy}
                                                onClick={() =>
                                                    it.action === "restore"
                                                        ? onRestore?.(it.id)
                                                        : onKeep?.(it.id)
                                                }
                                                title={
                                                    it.action === "restore"
                                                        ? "Return this song to the pool"
                                                        : "Force this song into the set on the next draft"
                                                }
                                            >
                                                {ACTION_LABEL[it.action]}
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {capped && (
                                <button
                                    type="button"
                                    className="nis-more"
                                    onClick={() => setFilter(g.key)}
                                >
                                    Show all {groupCounts.get(g.key)} in{" "}
                                    {g.label.toLowerCase()} →
                                </button>
                            )}
                        </div>
                    );
                })
            )}
        </section>
    );
}
