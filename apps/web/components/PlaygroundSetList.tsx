"use client";

import { Fragment } from "react";
import type { Seam, SetEntry } from "@repertoire/core";
import { SongRow } from "./SongRow";
import { SeamRow } from "./SeamRow";
import { useListReorder } from "./useListReorder";

// The playground's interactive set: drag to reorder, opener/closer anchors and a
// remove per row, seams between adjacent songs. Reuses SongRow/SeamRow and the
// shared reorder hook; its controls are arranging-only (no keep/exclude, since
// there is no pool to fill from). A song that has since been archived is kept and
// flagged rather than dropped.
export function PlaygroundSetList({
    entries,
    seams,
    open,
    close,
    archivedIds,
    busy,
    onReorder,
    onToggleOpen,
    onToggleClose,
    onRemove,
}: {
    entries: SetEntry[];
    seams: Seam[];
    open: string | null;
    close: string | null;
    archivedIds: Set<string>;
    busy: boolean;
    onReorder: (order: string[]) => void;
    onToggleOpen: (id: string) => void;
    onToggleClose: (id: string) => void;
    onRemove: (id: string) => void;
}) {
    const ids = entries.map((e) => e.song.id);
    const seamsAlign = seams.length === Math.max(0, entries.length - 1);
    const { gripProps, wrapProps, move } = useListReorder(ids, busy, onReorder);

    if (entries.length === 0) {
        return (
            <p className="empty">
                No songs yet. Add some from the repertoire below.
            </p>
        );
    }

    return (
        <div className="setlist">
            {entries.map((entry, i) => {
                const id = entry.song.id;
                const seam =
                    seamsAlign && i < entries.length - 1 ? seams[i] : undefined;
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
                                    <div className="row-controls">
                                        {archivedIds.has(id) && (
                                            <span
                                                className="badge low"
                                                title="This song has been archived in the repertoire"
                                            >
                                                archived
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            className={`ctl${open === id ? " on" : ""}`}
                                            disabled={busy}
                                            onClick={() => onToggleOpen(id)}
                                        >
                                            Opener
                                        </button>
                                        <button
                                            type="button"
                                            className={`ctl${close === id ? " on" : ""}`}
                                            disabled={busy}
                                            onClick={() => onToggleClose(id)}
                                        >
                                            Closer
                                        </button>
                                        <button
                                            type="button"
                                            className="ctl danger"
                                            disabled={busy}
                                            onClick={() => onRemove(id)}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                }
                            />
                        </div>
                        {seam && <SeamRow seam={seam} />}
                    </Fragment>
                );
            })}
        </div>
    );
}
