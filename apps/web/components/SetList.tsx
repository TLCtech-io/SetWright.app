import { Fragment } from "react";
import type { Seam, SetEntry } from "@repertoire/core";
import { SongRow } from "./SongRow";
import { SeamRow } from "./SeamRow";

// N songs with a seam between adjacent pairs. Match each seam to the pair it sits between
// by id, not array position — a segmented set (with breaks) drops the across-break seam, so
// positional indexing would misalign every seam after it. A missing pair just loses its one
// seam, never blanks the rest.
export function SetList({ set, seams }: { set: SetEntry[]; seams: Seam[] }) {
    const seamByPair = new Map(seams.map((s) => [`${s.fromId}:${s.toId}`, s]));

    return (
        <div className="setlist">
            {set.map((entry, i) => {
                const nextId = set[i + 1]?.song.id;
                const seam = nextId
                    ? seamByPair.get(`${entry.song.id}:${nextId}`)
                    : undefined;
                return (
                    <Fragment key={entry.song.id}>
                        <SongRow entry={entry} position={i + 1} />
                        {seam && <SeamRow seam={seam} />}
                    </Fragment>
                );
            })}
        </div>
    );
}
