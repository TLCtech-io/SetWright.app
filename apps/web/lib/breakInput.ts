// Coerce a setlist breaks write: { breaks: [{ id, label, durationSeconds, afterPosition }] }.
// A break needs a non-empty id and an afterPosition >= 1; the label defaults to
// "Intermission", the duration is clamped non-negative, and at most one break may sit
// at each ordinal slot (later duplicates drop, mirroring the schema's unique constraint).

import type { SetBreak } from "@repertoire/core";
import { MAX_SET_IDS } from "./limits";

type Result = { ok: true; value: SetBreak[] } | { ok: false; error: string };

const MAX_DURATION = 7200; // 2h, a generous ceiling
const MAX_LABEL = 80;

export function coerceBreaks(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const list = (raw as { breaks?: unknown }).breaks;
    if (!Array.isArray(list))
        return { ok: false, error: "breaks must be an array" };
    // This is a REPLACE write, so it is strict: a malformed entry (not an object, or missing a valid
    // id / positive slot) is REJECTED rather than dropped — a silent drop would partially apply the
    // payload and delete the omitted breaks. Only a duplicate slot is a harmless normalization.
    const seen = new Set<number>();
    const out: SetBreak[] = [];
    for (const x of list) {
        if (typeof x !== "object" || x === null)
            return { ok: false, error: "malformed break" };
        const o = x as {
            id?: unknown;
            label?: unknown;
            durationSeconds?: unknown;
            afterPosition?: unknown;
        };
        const id = typeof o.id === "string" && o.id ? o.id : "";
        // Cap the slot to a set-shaped length: after_position is smallint, so an absurd value (e.g.
        // 32768) would overflow the column on save. No break can meaningfully sit past the largest set.
        const afterPosition =
            typeof o.afterPosition === "number" &&
            Number.isFinite(o.afterPosition)
                ? Math.min(Math.round(o.afterPosition), MAX_SET_IDS)
                : 0;
        if (!id || afterPosition < 1)
            return { ok: false, error: "a break needs an id and a slot >= 1" };
        if (seen.has(afterPosition)) continue; // one break per ordinal slot — dedupe is a harmless normalize
        seen.add(afterPosition);
        const label =
            (typeof o.label === "string" ? o.label.trim() : "").slice(
                0,
                MAX_LABEL,
            ) || "Intermission";
        const durationSeconds =
            typeof o.durationSeconds === "number" &&
            Number.isFinite(o.durationSeconds) &&
            o.durationSeconds >= 0
                ? Math.min(MAX_DURATION, Math.round(o.durationSeconds))
                : 0;
        out.push({ id, label, durationSeconds, afterPosition });
    }
    return { ok: true, value: out };
}
