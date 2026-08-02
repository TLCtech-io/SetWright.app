"use client";

import type { Seam } from "@repertoire/core";
import { seamFlagLabel } from "@/lib/format";

// Gap presets offered on the seam, in seconds. 0 = attacca (segue, no pause).
const PRESETS = [0, 5, 10, 15, 30];

// The transition between two adjacent songs: a gap control (segue/attacca through a
// custom pause), the flags (the director-facing signal), and a clean rail otherwise.
// The gap is keyed by the song it LEAVES (seam.fromId); 0 makes an adjacent key
// clash matter more, which the flags then reflect after the re-cost.
// The transition props are optional: the editable set passes onSetTransition (the gap
// control renders); read-only views (the playground, a static set) pass neither and get
// the rail + flags, with a quiet "attacca" tag if a segue is already set.
export function SeamRow({
    seam,
    transition,
    busy,
    onSetTransition,
    onAddBreak,
}: {
    seam: Seam;
    transition?: number;
    busy?: boolean;
    onSetTransition?: (fromId: string, seconds: number | null) => void;
    onAddBreak?: () => void;
}) {
    const value = transition === undefined ? "" : String(transition);
    const custom = transition !== undefined && !PRESETS.includes(transition);
    return (
        <div
            className={`seam${seam.flags.length === 0 ? " clean" : ""}`}
            title={`seam cost ${seam.cost.toFixed(2)}`}
        >
            <div className="rail" />
            <div className="seam-controls">
                {onSetTransition ? (
                    <select
                        className={`seam-gap${transition === 0 ? " segue" : ""}`}
                        value={value}
                        disabled={busy}
                        aria-label="Transition into the next song"
                        onChange={(e) =>
                            onSetTransition(
                                seam.fromId,
                                e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                            )
                        }
                    >
                        <option value="">gap: default</option>
                        <option value="0">attacca (segue)</option>
                        {PRESETS.filter((p) => p !== 0).map((p) => (
                            <option key={p} value={p}>
                                {p}s gap
                            </option>
                        ))}
                        {custom && (
                            <option value={value}>{transition}s gap</option>
                        )}
                    </select>
                ) : (
                    transition === 0 && (
                        <span className="seam-gap segue">attacca</span>
                    )
                )}
                {onAddBreak && (
                    <button
                        type="button"
                        className="seam-add-break"
                        disabled={busy}
                        onClick={onAddBreak}
                    >
                        + break
                    </button>
                )}
                {seam.flags.length > 0 && (
                    <div className="seam-flags">
                        {seam.flags.map((flag) => (
                            <span key={flag} className="flag">
                                {seamFlagLabel(flag)}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
