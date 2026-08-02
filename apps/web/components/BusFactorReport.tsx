import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import type { BusFactorRow } from "@/lib/insights";

// The coverage-risk rows, grouped worst first: uncastable songs (short a part even
// with everyone present) then single-point songs (one absence away from dropping).
// Each group is a dense table, not a stack of cards: the group heading carries the
// severity, so every row is just the song (linked to its casting screen) and the
// parts or covers that break it. An empty report is the good case.
const GROUPS: {
    kind: BusFactorRow["kind"];
    label: string;
    note: string;
    head: string;
}[] = [
    {
        kind: "undercast",
        label: "Uncastable",
        note: "Short a required part even with everyone in",
        head: "Short a part",
    },
    {
        kind: "single-point",
        label: "One absence away",
        note: "A lone cover holds it up",
        head: "Sole covers",
    },
];

export function BusFactorReport({
    rows,
    songCount,
    songToken,
    prefix,
}: {
    rows: BusFactorRow[];
    songCount: number;
    // Song uuid -> URL token. The rows carry song uuids; the casting deep link needs the token.
    songToken: Map<string, string>;
    prefix: string;
}) {
    if (rows.length === 0) {
        return (
            <p className="empty">
                {songCount === 0
                    ? "No songs to check yet. Once your book has cast parts, this flags any part only one singer covers."
                    : `Every one of the ${songCount} active song${songCount === 1 ? "" : "s"} can be cast by the current roster, with a backup on every required part. No single points of failure.`}
            </p>
        );
    }

    return (
        <>
            {GROUPS.map((g) => {
                const groupRows = rows.filter((r) => r.kind === g.kind);
                if (groupRows.length === 0) return null;
                return (
                    <div key={g.kind} className="nis-group">
                        <div className="nis-group-head">
                            <span className="nis-group-label">{g.label}</span>
                            <span className="nis-group-count">
                                {groupRows.length}
                            </span>
                            <span className="nis-group-note">{g.note}</span>
                        </div>
                        <div className="hub-table-card coverage-card">
                            <div className="hub-table-scroll">
                                <table className="hub-table coverage-table">
                                    <thead>
                                        <tr>
                                            <th>Song</th>
                                            <th>{g.head}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {groupRows.map((row) => (
                                            <tr key={row.songId}>
                                                <td className="cell-title">
                                                    <Link
                                                        href={`${prefix}/repertoire/${songToken.get(row.songId) ?? row.songId}/casting`}
                                                    >
                                                        {row.title}
                                                    </Link>
                                                </td>
                                                <td className="coverage-cover">
                                                    {coverCell(row)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                );
            })}
        </>
    );
}

// The row's payload only: the short parts (undercast) or the critical singers (single-point),
// each lifted to ink. The group heading already states the kind of risk, so there is no
// repeated framing sentence to bury the names in.
function coverCell(row: BusFactorRow): ReactNode {
    if (row.kind === "undercast") {
        return row.shortParts.map((s, i) => (
            <Fragment key={s.label}>
                {i > 0 ? ", " : ""}
                <span className="rep-critical">
                    {s.label} (need {s.needed}, have {s.covered})
                </span>
            </Fragment>
        ));
    }
    return row.critical.map((c, i) => (
        <Fragment key={i}>
            {i > 0 ? ", " : ""}
            <span className="rep-critical">
                {c.displayName}
                {c.parts.length > 0 ? ` (${c.parts.join(", ")})` : ""}
            </span>
        </Fragment>
    ));
}
