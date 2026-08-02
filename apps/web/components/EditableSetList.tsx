"use client";

import { Fragment } from "react";
import type { Seam, SetBreak, SetEntry } from "@repertoire/core";
import type { PinState } from "@/lib/types";
import { Badge } from "./Badge";
import { SongRow } from "./SongRow";
import { SeamRow } from "./SeamRow";
import { BreakRow } from "./BreakRow";
import { RowControls } from "./RowControls";
import { PrepToggle } from "./PrepToggle";
import { SetItemNote } from "./SetItemNote";
import { useListReorder } from "./useListReorder";

// The interactive set: drag to reorder songs, pin controls per row, seams between
// adjacent songs, and breaks (intermissions) as ordinal dividers. A break sits at a
// slot (afterPosition), so the seam there is replaced by the break divider — no seam
// spans a break. Reordering is native HTML5 drag-and-drop on the songs; breaks stay at
// their slots, so dragging a song past a break just moves it across the intermission.
export function EditableSetList({
    entries,
    castShort,
    eventId,
    prepIds,
    seams,
    pins,
    notes,
    transitions,
    breaks,
    busy,
    onReorder,
    onSetOpen,
    onSetClose,
    onExclude,
    onUnkeep,
    onSetNote,
    onSetTransition,
    onAddBreak,
    onRemoveBreak,
    onEditBreakDuration,
}: {
    entries: SetEntry[];
    castShort: Record<string, string[]>; // songId -> uncoverable part labels, for the can't-cast flag
    eventId: string;
    prepIds: string[]; // the gig's committed songs, for the per-row prep toggle
    seams: Seam[];
    pins: PinState;
    notes: Record<string, string>;
    transitions: Record<string, number>;
    breaks: SetBreak[];
    busy: boolean;
    onReorder: (order: string[]) => void;
    onSetOpen: (id: string) => void;
    onSetClose: (id: string) => void;
    onExclude: (id: string) => void;
    onUnkeep: (id: string) => void;
    onSetNote: (songId: string, note: string) => void;
    onSetTransition: (fromId: string, seconds: number | null) => void;
    onAddBreak: (afterPosition: number) => void;
    onRemoveBreak: (id: string) => void;
    onEditBreakDuration: (id: string, seconds: number) => void;
}) {
    const ids = entries.map((e) => e.song.id);
    const prepSet = new Set(prepIds);
    // Match seams to the rows they sit between by id, not array position. If the
    // server's pool and the rendered order ever disagree on a song (a stale or
    // archived id, a load/reorder race), only that one gap loses its seam, instead
    // of a length mismatch blanking every seam.
    const seamByPair = new Map(seams.map((s) => [`${s.fromId}:${s.toId}`, s]));
    // Breaks by their ordinal slot (afterPosition = the gap after the k-th song).
    const breakAt = new Map(breaks.map((b) => [b.afterPosition, b]));
    const { gripProps, wrapProps, move } = useListReorder(ids, busy, onReorder);

    if (entries.length === 0) {
        return (
            <p className="empty">
                No songs in the set. Restore an excluded song or keep a dropped
                one.
            </p>
        );
    }

    return (
        <div className="setlist">
            {entries.map((entry, i) => {
                const id = entry.song.id;
                const nextId = entries[i + 1]?.song.id;
                const afterPosition = i + 1;
                const brk = breakAt.get(afterPosition);
                const seam = nextId
                    ? seamByPair.get(`${id}:${nextId}`)
                    : undefined;
                return (
                    <Fragment key={id}>
                        <div {...wrapProps(id)}>
                            <SongRow
                                entry={entry}
                                position={i + 1}
                                grip={
                                    <div className="reorder">
                                        <button
                                            type="button"
                                            className="move-btn"
                                            aria-label={`Move ${entry.song.title} earlier`}
                                            disabled={busy || i === 0}
                                            onClick={() => move(id, -1)}
                                        >
                                            ↑
                                        </button>
                                        <span
                                            className="grip"
                                            aria-hidden
                                            title="Drag to reorder"
                                            {...gripProps(id)}
                                        >
                                            ⋮⋮
                                        </span>
                                        <button
                                            type="button"
                                            className="move-btn"
                                            aria-label={`Move ${entry.song.title} later`}
                                            disabled={
                                                busy || i === entries.length - 1
                                            }
                                            onClick={() => move(id, 1)}
                                        >
                                            ↓
                                        </button>
                                    </div>
                                }
                                controls={
                                    <>
                                        <RowControls
                                            id={id}
                                            isOpener={pins.open === id}
                                            isCloser={pins.close === id}
                                            isKept={pins.keep.includes(id)}
                                            busy={busy}
                                            onSetOpen={onSetOpen}
                                            onSetClose={onSetClose}
                                            onExclude={onExclude}
                                            onUnkeep={onUnkeep}
                                        />
                                        <PrepToggle
                                            eventId={eventId}
                                            songId={id}
                                            initial={prepSet.has(id)}
                                        />
                                    </>
                                }
                                note={
                                    <SetItemNote
                                        songId={id}
                                        value={notes[id] ?? ""}
                                        busy={busy}
                                        onSet={onSetNote}
                                    />
                                }
                                flag={
                                    castShort[id]?.length ? (
                                        <Badge
                                            label={`Can't cast: ${castShort[id].join(", ")}`}
                                            tone="warn"
                                        />
                                    ) : undefined
                                }
                            />
                        </div>
                        {/* Between two songs: an intermission divider if one sits at this slot, else a
                seam (with its segue control and a "+ break" action). The last song has neither. */}
                        {nextId &&
                            (brk ? (
                                <BreakRow
                                    brk={brk}
                                    busy={busy}
                                    onRemove={onRemoveBreak}
                                    onEditDuration={onEditBreakDuration}
                                />
                            ) : seam ? (
                                <SeamRow
                                    seam={seam}
                                    transition={transitions[seam.fromId]}
                                    busy={busy}
                                    onSetTransition={onSetTransition}
                                    onAddBreak={() => onAddBreak(afterPosition)}
                                />
                            ) : null)}
                    </Fragment>
                );
            })}
        </div>
    );
}
