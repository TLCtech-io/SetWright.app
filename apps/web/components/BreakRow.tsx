"use client";

import type { SetBreak } from "@repertoire/core";
import { formatSeconds } from "@/lib/format";

// Duration presets offered for an intermission, in seconds (5/10/15/20 min).
const PRESETS = [300, 600, 900, 1200];

// An intermission divider in the editable set: its label, a length selector, and a
// remove control. Ordinal (it sits at a slot), so it does not drag with the songs.
export function BreakRow({
    brk,
    busy,
    onRemove,
    onEditDuration,
}: {
    brk: SetBreak;
    busy: boolean;
    onRemove: (id: string) => void;
    onEditDuration: (id: string, seconds: number) => void;
}) {
    const custom = !PRESETS.includes(brk.durationSeconds);
    return (
        <div className="break-row">
            <span className="break-label">{brk.label}</span>
            <select
                className="break-dur"
                value={String(brk.durationSeconds)}
                disabled={busy}
                aria-label="Intermission length"
                onChange={(e) => onEditDuration(brk.id, Number(e.target.value))}
            >
                {PRESETS.map((p) => (
                    <option key={p} value={p}>
                        {formatSeconds(p)}
                    </option>
                ))}
                {custom && (
                    <option value={String(brk.durationSeconds)}>
                        {formatSeconds(brk.durationSeconds)}
                    </option>
                )}
            </select>
            <button
                type="button"
                className="ctl danger break-remove"
                disabled={busy}
                aria-label="Remove intermission"
                onClick={() => onRemove(brk.id)}
            >
                Remove
            </button>
        </div>
    );
}
