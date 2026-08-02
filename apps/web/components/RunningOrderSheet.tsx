// A print-friendly running order: position, title, key, the starting pitch, and
// length. Pure presentation; the page computes the pitch (explicit per song, or
// the start key's tonic as a fallback) so this component imports no pitch math.

import { Fragment } from "react";

export interface SheetRow {
    position: number;
    title: string;
    keyText: string;
    pitch: string;
    duration: string;
    note?: string;
    segue?: boolean; // attacca into the next song — no pause
    breakRow?: { label: string; duration: string }; // when set, this row is an intermission divider
}

export function RunningOrderSheet({
    eventName,
    setName,
    rows,
    total,
}: {
    eventName: string;
    setName: string | null;
    rows: SheetRow[];
    total: string;
}) {
    const songCount = rows.filter((r) => !r.breakRow).length;
    return (
        <div className="sheet">
            <div className="page-head">
                <div>
                    <h1>{eventName}</h1>
                    <div className="sub">
                        {setName ? `${setName} · ` : ""}
                        {songCount} song{songCount === 1 ? "" : "s"} · {total}
                    </div>
                </div>
            </div>

            <div className="hub-table-card sheet-card">
                <table className="sheet-table">
                    <thead>
                        <tr>
                            <th className="num">#</th>
                            <th>Song</th>
                            <th>Key</th>
                            <th>Starting Pitch</th>
                            <th className="len">Length</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) =>
                            r.breakRow ? (
                                <tr className="break-sheet-row" key={i}>
                                    <td />
                                    <td colSpan={4}>
                                        {r.breakRow.label} (
                                        {r.breakRow.duration})
                                    </td>
                                </tr>
                            ) : (
                                <Fragment key={i}>
                                    <tr>
                                        <td className="num">{r.position}</td>
                                        <td className="ttl">{r.title}</td>
                                        <td>{r.keyText}</td>
                                        <td className="pitch">{r.pitch}</td>
                                        <td className="len">{r.duration}</td>
                                    </tr>
                                    {r.note ? (
                                        <tr className="note-row">
                                            <td />
                                            <td colSpan={4}>{r.note}</td>
                                        </tr>
                                    ) : null}
                                    {r.segue ? (
                                        <tr className="segue-row">
                                            <td />
                                            <td colSpan={4}>
                                                attacca, straight into the next
                                            </td>
                                        </tr>
                                    ) : null}
                                </Fragment>
                            ),
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
