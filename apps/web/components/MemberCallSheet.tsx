import { Fragment } from "react";
import Link from "next/link";
import type { Confidence } from "@repertoire/core";
import type { CallSheetView } from "@/lib/callSheet";
import { EventRsvp } from "./EventRsvp";

const CONF_LABEL: Record<Confidence, string> = {
    solid: "solid",
    shaky: "shaky",
    learning: "learning",
};

// One "who's coming" line for a section's answer bucket, omitted when the bucket is empty. Mirrors
// MySchedule's Bucket, rendered server-side here (a single event needs no expand/collapse).
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

// The read-only member view of an event. The director sees the management console on
// this same route; this side renders the running order the director shared (or the set as
// performed), the member's own parts for the night, who's coming, and their RSVP. It imports no
// director write control — only EventRsvp, which writes the member's own attendance row.
export function MemberCallSheet({
    ensembleId,
    view,
}: {
    ensembleId: string;
    view: CallSheetView;
}) {
    const { header, set, isDraft, myParts, groups } = view;
    const meta = [
        header.dateLabel,
        header.venue,
        header.eventType,
        header.targetLabel,
    ]
        .filter(Boolean)
        .join(" · ");
    const when =
        header.daysUntil == null
            ? null
            : header.daysUntil === 0
              ? "Today"
              : header.daysUntil === 1
                ? "Tomorrow"
                : `In ${header.daysUntil} days`;

    return (
        <main className="page callsheet">
            <Link href={`/e/${ensembleId}/me/schedule`} className="back-link">
                &larr; Your schedule
            </Link>

            <div className="page-head">
                <div>
                    <h1>{header.name}</h1>
                    <div className="sub">
                        {meta}
                        {header.kind === "rehearsal" && (
                            <span className="role-tag">rehearsal</span>
                        )}
                        {header.cancelled && (
                            <span className="role-tag pending">cancelled</span>
                        )}
                    </div>
                </div>
                {when && !header.cancelled && (
                    <span className="callsheet-when">{when}</span>
                )}
            </div>

            {!header.cancelled && !header.isPast && (
                <EventRsvp
                    eventId={view.eventId}
                    initial={view.myStatus}
                    eventName={header.name}
                />
            )}

            {set ? (
                <section className="callsheet-section">
                    {isDraft && (
                        <p className="callsheet-draft-banner" role="status">
                            <span className="callsheet-draft-tag">Draft</span>
                            This set is still being shaped. Songs and order may
                            change before the show.
                        </p>
                    )}
                    <div className="section-head">
                        <p className="section-label">
                            {isDraft ? "Draft running order" : "Running order"}
                        </p>
                        <span className="callsheet-setmeta">
                            {set.status === "performed"
                                ? `As performed${set.performedDate ? ` · ${set.performedDate}` : ""}`
                                : isDraft
                                  ? "Subject to change"
                                  : "Shared by your director"}
                            {` · ${set.songCount} song${set.songCount === 1 ? "" : "s"} · ${set.total}`}
                        </span>
                    </div>
                    <div className="hub-table-card sheet-card">
                        <table className="sheet-table callsheet-table stack-mobile">
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
                                {set.rows.map((r, i) =>
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
                                            <tr
                                                className={
                                                    r.mine
                                                        ? "callsheet-mine"
                                                        : undefined
                                                }
                                            >
                                                <td
                                                    className="num"
                                                    data-label="No."
                                                >
                                                    {r.position}
                                                </td>
                                                <td className="ttl">
                                                    {r.title}
                                                    {r.mine && (
                                                        <span className="callsheet-youtag">
                                                            you
                                                            {r.mine.isLead
                                                                ? " · lead"
                                                                : ""}
                                                        </span>
                                                    )}
                                                </td>
                                                <td data-label="Key">
                                                    {r.keyText}
                                                </td>
                                                <td
                                                    className="pitch"
                                                    data-label="Pitch"
                                                >
                                                    {r.pitch}
                                                </td>
                                                <td
                                                    className="len"
                                                    data-label="Length"
                                                >
                                                    {r.duration}
                                                </td>
                                            </tr>
                                            {r.note ? (
                                                <tr className="note-row">
                                                    <td />
                                                    <td colSpan={4}>
                                                        {r.note}
                                                    </td>
                                                </tr>
                                            ) : null}
                                            {r.segue ? (
                                                <tr className="segue-row">
                                                    <td />
                                                    <td colSpan={4}>
                                                        attacca, straight into
                                                        the next
                                                    </td>
                                                </tr>
                                            ) : null}
                                        </Fragment>
                                    ),
                                )}
                            </tbody>
                        </table>
                    </div>

                    {myParts.length > 0 && (
                        <div className="callsheet-myparts">
                            <p className="section-label">
                                Your parts in this set
                            </p>
                            <ul className="callsheet-partlist">
                                {myParts.map((p, i) => {
                                    const cl = p.confidence
                                        ? CONF_LABEL[p.confidence]
                                        : null;
                                    return (
                                        <li
                                            key={`${p.songId}-${i}`}
                                            className="callsheet-part"
                                        >
                                            <span className="callsheet-part-song">
                                                {p.songTitle}
                                                <span className="callsheet-part-label">
                                                    {p.partLabel}
                                                    {p.isLead &&
                                                    p.partLabel.toLowerCase() !==
                                                        "lead"
                                                        ? " · lead"
                                                        : ""}
                                                </span>
                                            </span>
                                            <span className="callsheet-part-facts">
                                                {[
                                                    p.pitch
                                                        ? `pitch ${p.pitch}`
                                                        : null,
                                                    p.keyText,
                                                    p.tempo,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                            </span>
                                            <span
                                                className={`callsheet-part-conf${cl ? "" : " muted"}`}
                                            >
                                                {cl ?? "not rated"}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                </section>
            ) : (
                header.kind === "gig" &&
                !header.cancelled && (
                    <p className="empty callsheet-nopublish">
                        The set isn&rsquo;t published yet. Your director will
                        share the running order here.
                    </p>
                )
            )}

            {!header.cancelled && groups.length > 0 && (
                <section className="callsheet-section">
                    <div className="section-head">
                        <p className="section-label">Who&rsquo;s coming</p>
                        <span className="callsheet-setmeta">
                            {groups.reduce((n, g) => n + g.in.length, 0)} in
                        </span>
                    </div>
                    <div className="whoscoming callsheet-whoscoming">
                        {groups.map((g) => (
                            <div
                                className="wc-group"
                                key={g.sectionId ?? "unassigned"}
                            >
                                <span className="wc-section">{g.section}</span>
                                <span className="wc-names">
                                    <Bucket label="In" names={g.in} tone="in" />
                                    <Bucket
                                        label="Maybe"
                                        names={g.tentative}
                                        tone="tentative"
                                    />
                                    <Bucket
                                        label="Out"
                                        names={g.out}
                                        tone="out"
                                    />
                                    <Bucket
                                        label="No reply"
                                        names={g.pending}
                                        tone="pending"
                                    />
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </main>
    );
}
