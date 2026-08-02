import Link from "next/link";
import { Fragment } from "react";
import { clockSeconds, type SetEntry } from "@repertoire/core";
import type { PerformedSet } from "@/lib/db";
import { SongRow } from "./SongRow";
import { formatSeconds } from "@/lib/format";
import { CloneSetButton } from "./CloneSetButton";

// A performed set is read-only: its frozen order, the date it ran, a print link,
// and a clone control. No drag, pins, re-generate, or perform.
export function PerformedSetView({
    performed,
    events,
    ensembleId,
}: {
    performed: PerformedSet;
    events: { id: string; name: string }[];
    ensembleId: string;
}) {
    const entries: SetEntry[] = performed.songs.map((s) => ({
        song: s,
        stage: s.durationSeconds ?? 0,
    }));
    const total = clockSeconds(
        performed.songs,
        performed.padding,
        new Map(Object.entries(performed.transitions)),
        performed.breaks,
    );
    // A song with an unset length contributes 0 to the clock, so the total is a floor: mark it with a
    // "+" (mirrors the sheet page + TimingBar), rather than showing an exact time that understates.
    const unknownDuration = performed.songs.some(
        (s) => s.durationSeconds == null,
    );
    const breakAt = new Map(performed.breaks.map((b) => [b.afterPosition, b]));

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/events`} className="back-link">
                &larr; All events
            </Link>
            <div className="page-head">
                <div>
                    <h1>{performed.eventName}</h1>
                    <div className="sub">
                        {performed.name ? `${performed.name} · ` : ""}Performed{" "}
                        {performed.date} · {entries.length} song
                        {entries.length === 1 ? "" : "s"} ·{" "}
                        {formatSeconds(total)}
                        {unknownDuration ? "+" : ""}
                    </div>
                </div>
                <div className="head-actions">
                    <Link
                        href={`/e/${ensembleId}/setlist/${performed.setlistPublicId}/sheet`}
                        className="ctl regen"
                    >
                        Print running order
                    </Link>
                </div>
            </div>

            <p className="status status-static">
                This set was performed, so it is read-only. Clone it to start a
                new draft.
            </p>

            <div className="setlist">
                {entries.map((entry, i) => {
                    const note = performed.notes[entry.song.id];
                    const brk = breakAt.get(i + 1);
                    const segue =
                        performed.transitions[entry.song.id] === 0 &&
                        !brk &&
                        i < entries.length - 1;
                    return (
                        <Fragment key={entry.song.id}>
                            <SongRow
                                entry={entry}
                                position={i + 1}
                                note={
                                    note ? (
                                        <div className="set-note read">
                                            {note}
                                        </div>
                                    ) : undefined
                                }
                            />
                            {segue && (
                                <div className="segue-mark">
                                    attacca, straight into the next
                                </div>
                            )}
                            {brk && (
                                <div className="break-mark">
                                    {brk.label} ·{" "}
                                    {formatSeconds(brk.durationSeconds)}
                                </div>
                            )}
                        </Fragment>
                    );
                })}
            </div>

            <div className="pg-link">
                <p className="section-label">Clone to an event</p>
                <CloneSetButton
                    setlistId={performed.setlistId}
                    events={events}
                />
            </div>
        </main>
    );
}
