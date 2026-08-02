// Coerce an untrusted member-profile payload (the member's self-edit) into a clean
// ProfileInput. Only display name + vocal range — a member can't touch role, sections,
// status, or their account link (mirrors what update_my_profile allows). Range notes arrive
// as scientific-pitch strings ("G3") and convert to MIDI via core's one pitch module, the
// same as the director's coerceMemberInput.

import { midi } from "@repertoire/core";
import type { ProfileInput } from "./db";

type Result = { ok: true; value: ProfileInput } | { ok: false; error: string };

function parseNote(v: unknown): number | null {
    if (typeof v !== "string" || !v.trim()) return null;
    try {
        const n = midi(v.trim());
        return n >= 0 && n <= 127 ? n : null;
    } catch {
        return null;
    }
}

export function coerceProfileInput(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const displayName =
        typeof r.displayName === "string" ? r.displayName.trim() : "";
    if (!displayName) return { ok: false, error: "a name is required" };

    let low = parseNote(r.rangeLow);
    let high = parseNote(r.rangeHigh);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];

    return {
        ok: true,
        value: { displayName, rangeLowMidi: low, rangeHighMidi: high },
    };
}
