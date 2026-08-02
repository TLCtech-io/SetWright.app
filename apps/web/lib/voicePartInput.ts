// Coerce an untrusted voice-part (section) payload into a clean VoicePartInput.
// label is required; isPitched defaults true; the nominal range arrives as
// scientific pitch ("C4"), converts to MIDI via core's one pitch module, and is
// ordered low <= high (matching the schema's range check).

import { midi } from "@repertoire/core";
import type { VoicePartInput } from "./db";

type Result =
    | { ok: true; value: VoicePartInput }
    | { ok: false; error: string };

function noteOrNull(v: unknown): number | null {
    if (typeof v !== "string" || !v.trim()) return null;
    try {
        const n = midi(v.trim());
        return n >= 0 && n <= 127 ? n : null;
    } catch {
        return null;
    }
}

export function coerceVoicePartInput(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) return { ok: false, error: "a section name is required" };
    if (label.length > 40)
        return { ok: false, error: "section name is too long" };

    const isPitched = r.isPitched !== false; // default true; only an explicit false opts out

    let low = noteOrNull(r.nominalLow);
    let high = noteOrNull(r.nominalHigh);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    // An unpitched section (e.g. vocal percussion) carries no range; drop any range
    // sent alongside it so the stored row can't hold an orphaned low/high.
    if (!isPitched) {
        low = null;
        high = null;
    }

    return {
        ok: true,
        value: { label, isPitched, nominalLowMidi: low, nominalHighMidi: high },
    };
}
