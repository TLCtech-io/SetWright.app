// Coerce an untrusted padding-profile payload into a clean PaddingProfileInput.
// name is required; the two overhead values are non-negative integer seconds.

import type { PaddingProfileInput } from "./db";

type Result =
    | { ok: true; value: PaddingProfileInput }
    | { ok: false; error: string };

// Overhead is stored integer seconds; clamp to a 1h ceiling (matching eventInput's padding cap) so
// an absurd value can't overflow the column or ask the drafter to reserve hours of dead air.
const MAX_PADDING_SECONDS = 3_600;
const nonNegInt = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.min(Math.round(v), MAX_PADDING_SECONDS)
        : 0;

export function coercePaddingProfileInput(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) return { ok: false, error: "a profile name is required" };
    if (name.length > 40)
        return { ok: false, error: "profile name is too long" };

    return {
        ok: true,
        value: {
            name,
            perSongSeconds: nonNegInt(r.perSongSeconds),
            perSetSeconds: nonNegInt(r.perSetSeconds),
        },
    };
}
