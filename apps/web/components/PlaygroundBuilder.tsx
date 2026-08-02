"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { indexByPart, seamsFor, sequence } from "@repertoire/core";
import type {
    AssessedReadiness,
    Casting,
    Part,
    SetEntry,
    Song,
} from "@repertoire/core";
import { formatSeconds } from "@/lib/format";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { PlaygroundSetList } from "./PlaygroundSetList";
import { TimingBar } from "./TimingBar";
import { BalanceArc } from "./BalanceArc";

export interface RepertoireEntry {
    song: Song;
    parts: Part[];
    castings: Casting[];
    active: boolean; // false = archived in the repertoire; kept in a program, not offered to add
}

// The Add-songs rail mirrors the repertoire list's sort. Status is not offered here:
// the rail only ever shows active, not-yet-added songs.
type SortKey = "title" | "readiness" | "duration" | "rehearsed";
const READINESS: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
    "learning",
    "dormant",
];

interface Program {
    id: string;
    name: string;
    songIds: string[];
    open: string | null;
    close: string | null;
}

// A nominal per-song gap for seam scoring. The playground has no event padding, so
// this just sets how forgiving the key-clash term is; it does not pad the timing.
const GAP_SECONDS = 30;

// A scratchpad for hand-building a saved song order (a "program") off the book, with no event or
// roster to satisfy. Shows live timing and seam scoring as the director reorders. Songs archived
// since the program was saved stay in the list but are not offered to add.
export function PlaygroundBuilder({
    program,
    repertoire,
    events,
}: {
    program: Program;
    repertoire: RepertoireEntry[];
    events: { id: string; name: string }[];
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();

    const byId = useMemo(
        () => new Map(repertoire.map((r) => [r.song.id, r])),
        [repertoire],
    );
    const partsBySong = useMemo(
        () => new Map(repertoire.map((r) => [r.song.id, r.parts])),
        [repertoire],
    );
    const castingsByPart = useMemo(
        () => indexByPart(repertoire.flatMap((r) => r.castings)),
        [repertoire],
    );

    const [name, setName] = useState(program.name);
    // Keep every song the program lists, including one archived since it was saved
    // (byId carries those too); only a genuinely missing id is dropped. Anchors are
    // clamped to the list and to each other, so a stored inconsistency never renders.
    const initialIds = program.songIds.filter((id) => byId.has(id));
    const [songIds, setSongIds] = useState<string[]>(initialIds);
    const [open, setOpen] = useState<string | null>(
        program.open && initialIds.includes(program.open) ? program.open : null,
    );
    const [close, setClose] = useState<string | null>(
        program.close &&
            program.close !== program.open &&
            initialIds.includes(program.close)
            ? program.close
            : null,
    );
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [eventId, setEventId] = useState<string>(events[0]?.id ?? "");

    const touch = () => {
        setDirty(true);
        setStatus(null);
    };

    const songs = useMemo(
        () => songIds.map((id) => byId.get(id)!.song),
        [songIds, byId],
    );
    const entries: SetEntry[] = useMemo(
        () => songs.map((song) => ({ song, stage: song.durationSeconds ?? 0 })),
        [songs],
    );
    const seams = useMemo(
        () =>
            songs.length >= 2
                ? seamsFor(songs, {
                      partsBySong,
                      castingsByPart,
                      perSongGapSeconds: GAP_SECONDS,
                  })
                : [],
        [songs, partsBySong, castingsByPart],
    );
    const total = entries.reduce((sum, e) => sum + e.stage, 0);
    // Only active songs are offered to add; archived ones already in the program stay.
    const available = useMemo(
        () =>
            repertoire.filter((r) => r.active && !songIds.includes(r.song.id)),
        [repertoire, songIds],
    );
    const archivedIds = useMemo(
        () =>
            new Set(repertoire.filter((r) => !r.active).map((r) => r.song.id)),
        [repertoire],
    );

    // The rail library can be the whole active book, so give it the repertoire list's
    // search, tag filter, and sort. Search covers title and tag names (no arranger on the
    // core song). The tag chips come from the whole active book, not just what is currently
    // addable, so the chip set stays put as songs move in and out of the program.
    const [addQuery, setAddQuery] = useState("");
    const [sort, setSort] = useState<SortKey>("title");
    const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
    const toggleTag = (t: string) =>
        setActiveTags((prev) => {
            const next = new Set(prev);
            if (next.has(t)) next.delete(t);
            else next.add(t);
            return next;
        });
    const libTags = useMemo(() => {
        const set = new Set<string>();
        for (const r of repertoire)
            if (r.active) for (const t of r.song.tags) set.add(t.name);
        return [...set].sort((a, b) => a.localeCompare(b));
    }, [repertoire]);
    const filteredAvailable = useMemo(() => {
        const q = addQuery.trim().toLowerCase();
        const rows = available.filter((r) => {
            if (
                activeTags.size > 0 &&
                !r.song.tags.some((t) => activeTags.has(t.name))
            )
                return false;
            if (q) {
                const hay = [r.song.title, ...r.song.tags.map((t) => t.name)]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        const byTitle = (a: RepertoireEntry, b: RepertoireEntry) =>
            a.song.title.localeCompare(b.song.title);
        const cmp = (a: RepertoireEntry, b: RepertoireEntry): number => {
            if (sort === "readiness") {
                return (
                    READINESS.indexOf(a.song.assessedReadiness) -
                        READINESS.indexOf(b.song.assessedReadiness) ||
                    byTitle(a, b)
                );
            }
            if (sort === "duration") {
                return (
                    (a.song.durationSeconds ?? Infinity) -
                        (b.song.durationSeconds ?? Infinity) || byTitle(a, b)
                );
            }
            if (sort === "rehearsed") {
                // Most recently rehearsed first; never-rehearsed (null) sorts last.
                return (
                    (b.song.lastRehearsed ?? "").localeCompare(
                        a.song.lastRehearsed ?? "",
                    ) || byTitle(a, b)
                );
            }
            return byTitle(a, b);
        };
        return [...rows].sort(cmp);
    }, [available, addQuery, sort, activeTags]);

    const add = (id: string) => {
        setSongIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        touch();
    };
    const remove = (id: string) => {
        setSongIds((prev) => prev.filter((x) => x !== id));
        if (open === id) setOpen(null);
        if (close === id) setClose(null);
        touch();
    };
    const toggleOpen = (id: string) => {
        setOpen((o) => (o === id ? null : id));
        if (close === id) setClose(null); // a song cannot anchor both ends
        touch();
    };
    const toggleClose = (id: string) => {
        setClose((c) => (c === id ? null : id));
        if (open === id) setOpen(null);
        touch();
    };
    const reorder = (next: string[]) => {
        setSongIds(next);
        touch();
    };

    // Suggest an order with the sequencer, honoring the opener/closer anchors.
    const autoArrange = () => {
        const openSong = open ? byId.get(open)?.song : undefined;
        const closeSong =
            close && close !== open ? byId.get(close)?.song : undefined;
        const pinned = new Set(
            [open, close].filter((x): x is string => x !== null),
        );
        const middle = songIds
            .filter((id) => !pinned.has(id))
            .map((id) => byId.get(id)!.song);
        const res = sequence({
            middle,
            open: openSong,
            close: closeSong,
            partsBySong,
            castingsByPart,
            perSongGapSeconds: GAP_SECONDS,
        });
        setSongIds(res.order.map((s) => s.id));
        touch();
        setStatus("Auto-arranged. Drag to fine-tune.");
    };

    const persist = async (): Promise<boolean> => {
        const res = await fetch(`/api${prefix}/playground/${program.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                name: name.trim() || "Untitled program",
                songIds,
                open,
                close,
            }),
        });
        return res.ok;
    };

    const save = async () => {
        setBusy(true);
        setStatus(null);
        const ok = await persist().catch(() => false);
        setBusy(false);
        if (ok) {
            setName((n) => n.trim() || "Untitled program"); // show what was actually stored
            setDirty(false);
            setStatus("Saved.");
        } else {
            setStatus("Could not save.");
        }
    };

    const linkToEvent = async () => {
        if (!eventId) return;
        setBusy(true);
        setStatus(null);
        // The link reads the stored program, so save the current state first.
        const saved = await persist().catch(() => false);
        if (!saved) {
            setBusy(false);
            setStatus("Could not save before linking.");
            return;
        }
        setDirty(false);
        try {
            const res = await fetch(
                `/api${prefix}/playground/${program.id}/link`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ eventId }),
                },
            );
            if (res.ok) {
                const { publicId } = await res.json();
                router.push(`${prefix}/setlist/${publicId}`);
                return;
            }
            setStatus("Could not create the event setlist.");
        } catch {
            setStatus("Could not reach the server.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div className="page-head">
                <div>
                    <input
                        className="pg-name"
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                            touch();
                        }}
                        placeholder="Program name"
                        aria-label="Program name"
                    />
                    <div className="sub">
                        {entries.length} song{entries.length === 1 ? "" : "s"}
                        {" · no staffing"}
                    </div>
                </div>
                <div className="head-actions">
                    <button
                        type="button"
                        className="ctl regen"
                        disabled={busy || songs.length < 2}
                        onClick={autoArrange}
                    >
                        Auto-arrange
                    </button>
                    <button
                        type="button"
                        className="perform"
                        disabled={busy || !dirty}
                        onClick={save}
                    >
                        {dirty ? "Save" : "Saved"}
                    </button>
                </div>
            </div>

            {status && <p className="status">{status}</p>}

            <TimingBar
                totalSeconds={total}
                targetSeconds={null}
                unknownDurations={songs.some((s) => s.durationSeconds == null)}
            />

            <BalanceArc entries={entries} seams={seams} />

            <div className="setlist-workspace">
                <div className="set-main">
                    <div className="module-head">
                        <h2 className="module-title">The program</h2>
                        <span className="module-count">
                            {entries.length} song
                            {entries.length === 1 ? "" : "s"}
                        </span>
                    </div>

                    <PlaygroundSetList
                        entries={entries}
                        seams={seams}
                        open={open}
                        close={close}
                        archivedIds={archivedIds}
                        busy={busy}
                        onReorder={reorder}
                        onToggleOpen={toggleOpen}
                        onToggleClose={toggleClose}
                        onRemove={remove}
                    />
                </div>

                <aside className="set-rail">
                    <div className="panel pg-library">
                        <div className="module-head">
                            <h2 className="module-title">Add songs</h2>
                            <span className="module-count">
                                {filteredAvailable.length}
                            </span>
                        </div>
                        {available.length > 0 && (
                            <div className="pg-lib-controls">
                                <input
                                    className="pg-lib-search"
                                    type="text"
                                    value={addQuery}
                                    onChange={(e) =>
                                        setAddQuery(e.target.value)
                                    }
                                    placeholder="Search the book…"
                                    aria-label="Search songs to add"
                                />
                                <select
                                    className="pg-lib-sort"
                                    value={sort}
                                    onChange={(e) =>
                                        setSort(e.target.value as SortKey)
                                    }
                                    aria-label="Sort songs to add"
                                >
                                    <option value="title">Sort: Title</option>
                                    <option value="readiness">
                                        Sort: Readiness
                                    </option>
                                    <option value="duration">
                                        Sort: Length
                                    </option>
                                    <option value="rehearsed">
                                        Sort: Last rehearsed
                                    </option>
                                </select>
                                {libTags.length > 0 && (
                                    <div
                                        className="filter-chips"
                                        role="group"
                                        aria-label="Filter songs to add by tag"
                                    >
                                        {libTags.map((t) => {
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
                        )}
                        {available.length === 0 ? (
                            <p className="empty">
                                Every active song is in the program.
                            </p>
                        ) : filteredAvailable.length === 0 ? (
                            <p className="empty">No songs match.</p>
                        ) : (
                            <div className="pg-lib-list">
                                {filteredAvailable.map((r) => (
                                    <div key={r.song.id} className="pg-lib-row">
                                        <div className="pg-lib-body">
                                            <div className="pg-lib-title">
                                                {r.song.title}
                                            </div>
                                            <div className="pg-lib-meta">
                                                {r.song.assessedReadiness}{" "}
                                                &middot;{" "}
                                                {r.song.durationSeconds != null
                                                    ? formatSeconds(
                                                          r.song
                                                              .durationSeconds,
                                                      )
                                                    : "no length"}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="ctl"
                                            disabled={busy}
                                            onClick={() => add(r.song.id)}
                                        >
                                            Add
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {events.length > 0 && (
                        <div className="panel pg-link">
                            <p className="section-label">Use for an event</p>
                            <p className="hint">
                                Seeds the program into an event setlist and
                                opens it, so you can check coverage against who
                                is available.
                            </p>
                            <div className="pg-link-row">
                                <select
                                    value={eventId}
                                    onChange={(e) => setEventId(e.target.value)}
                                    disabled={busy}
                                    aria-label="Event"
                                >
                                    {events.map((e) => (
                                        <option key={e.id} value={e.id}>
                                            {e.name}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    className="ctl"
                                    disabled={busy || songs.length === 0}
                                    onClick={linkToEvent}
                                >
                                    Use for event
                                </button>
                            </div>
                        </div>
                    )}
                </aside>
            </div>
        </>
    );
}
