import type { ReactNode } from "react";
import type { SetEntry } from "@repertoire/core";
import { formatKeyRange, formatSeconds, formatTempo } from "@/lib/format";
import { Badge, type BadgeTone } from "./Badge";

const READINESS: Record<string, { label: string; tone: BadgeTone }> = {
    "performance-ready": { label: "performance-ready", tone: "ready" },
    "needs-polish": { label: "needs-polish", tone: "polish" },
    learning: { label: "learning", tone: "learn" },
    dormant: { label: "dormant", tone: "low" },
};

// One entry in the set. Pure and presentational, so it renders in both the
// read-only view and the editable client list. `grip` and `controls` are
// optional slots the editable list fills; read-only callers pass neither.
// Two lines: title + readiness + time on top, one quiet metadata line and the
// actions below, then an optional full-width note. Every nullable field degrades
// to a quiet placeholder rather than a guess.
export function SongRow({
    entry,
    position,
    grip,
    controls,
    note,
    flag,
}: {
    entry: SetEntry;
    position: number;
    grip?: ReactNode;
    controls?: ReactNode;
    note?: ReactNode;
    flag?: ReactNode; // a warning badge (e.g. an uncastable pinned song), beside the title
}) {
    const { song } = entry;
    const readiness = READINESS[song.assessedReadiness] ?? {
        label: song.assessedReadiness,
        tone: "low" as BadgeTone,
    };
    // Key, tempo, and intensity read as one quiet mono line instead of competing
    // pills; readiness stays a badge (its colour is the load-bearing signal).
    const meta = [
        formatKeyRange(song.startKey, song.endKey),
        formatTempo(song.startTempoBpm, song.endTempoBpm),
        song.intensity !== null ? `intensity ${song.intensity}` : null,
    ]
        .filter((x): x is string => !!x)
        .join(" · ");

    return (
        <div className="song">
            {grip}
            <div className="pos">{position}</div>
            <div className="song-main">
                <div className="song-top">
                    <div className="song-headline">
                        <span className="title">{song.title}</span>
                        <Badge label={readiness.label} tone={readiness.tone} />
                        {song.isExplicit && (
                            <Badge label="explicit" tone="explicit" />
                        )}
                        {flag}
                    </div>
                    <span className="stage">
                        {song.durationSeconds != null
                            ? formatSeconds(song.durationSeconds)
                            : "—"}
                    </span>
                </div>
                <div className="song-bottom">
                    <span className="meta">{meta}</span>
                    {controls}
                </div>
                {note}
            </div>
        </div>
    );
}
