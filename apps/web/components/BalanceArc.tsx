import { Fragment } from "react";
import type { Seam, SetBreak, SetEntry } from "@repertoire/core";

// The set's energy arc at a glance: a bar per song by intensity, the tempo
// printed under it, and an amber tick where the seam to the next song carries a
// warning. Reads raw Song fields in the displayed order; the sequencer's own
// per-song scoring stays internal. Reflects hand-arrangement, since it takes the
// live entries. Breaks split the arc into segments — a gap divider marks each
// intermission, and no seam (so no warning) spans a break.

const band = (n: number | null): string =>
    n == null ? "na" : n >= 4 ? "hot" : n >= 3 ? "mid" : "cool";

export function BalanceArc({
    entries,
    seams,
    breaks = [],
}: {
    entries: SetEntry[];
    seams: Seam[];
    breaks?: SetBreak[];
}) {
    if (entries.length < 2) return null; // an arc needs at least a couple of songs

    // Match the seam to the pair it sits between by id, not position — across a break
    // there is no seam, so position indexing would misalign every warning after it.
    const seamByPair = new Map(seams.map((s) => [`${s.fromId}:${s.toId}`, s]));
    const breakAt = new Map(breaks.map((b) => [b.afterPosition, b]));
    // Plain-language legend; the intermission note only appears when the set actually has a break.
    const legend =
        "Bar height = intensity · number = bpm · amber tick = a rough transition" +
        (breaks.length > 0 ? " · gap = intermission" : "");

    return (
        <div className="arc">
            <div className="module-head">
                <h2 className="module-title">Set arc</h2>
            </div>
            <div className="arc-grid">
                {entries.map((e, i) => {
                    const intensity = e.song.intensity;
                    const height =
                        intensity != null ? 20 + (intensity / 5) * 80 : 8;
                    const tempo = e.song.startTempoBpm;
                    // Only the musical categories describe feel; occasion is ignored by the
                    // sequencer and content is a gate, so neither belongs in an arc tooltip.
                    const feel = e.song.tags.find(
                        (t) =>
                            t.category === "mood" ||
                            t.category === "groove" ||
                            t.category === "genre",
                    )?.name;
                    const nextId = entries[i + 1]?.song.id;
                    const seam = nextId
                        ? seamByPair.get(`${e.song.id}:${nextId}`)
                        : undefined;
                    const seamWarn = (seam?.flags.length ?? 0) > 0;
                    const brk = breakAt.get(i + 1);
                    const tip = [
                        `${i + 1}. ${e.song.title}`,
                        intensity != null
                            ? `intensity ${intensity}`
                            : "intensity unrated",
                        tempo != null ? `${tempo} bpm` : "free tempo",
                        feel ?? null,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    return (
                        <Fragment key={e.song.id}>
                            <div
                                className={`arc-col${seamWarn ? " seam-warn" : ""}`}
                                title={tip}
                            >
                                <div className="arc-track">
                                    <div
                                        className={`arc-bar ${band(intensity)}`}
                                        style={{
                                            height: `${height}%`,
                                            animationDelay: `${Math.min(i, 10) * 16}ms`,
                                        }}
                                    />
                                </div>
                                <div className="arc-tempo">
                                    {tempo != null ? tempo : "—"}
                                </div>
                                <div className="arc-pos">{i + 1}</div>
                            </div>
                            {brk && (
                                <div
                                    className="arc-break"
                                    title={brk.label}
                                    aria-label={brk.label}
                                />
                            )}
                        </Fragment>
                    );
                })}
            </div>
            <p className="arc-legend">{legend}</p>
        </div>
    );
}
