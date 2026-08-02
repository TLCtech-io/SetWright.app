// Coerce an untrusted member-RSVP payload into a valid availability status.
import type { AvailabilityStatus } from "@repertoire/core";

const STATUSES: AvailabilityStatus[] = ["in", "out", "tentative"];

type Result =
    | { ok: true; value: AvailabilityStatus }
    | { ok: false; error: string };

export function coerceRsvpStatus(raw: unknown): Result {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (STATUSES.includes(r.status as AvailabilityStatus))
        return { ok: true, value: r.status as AvailabilityStatus };
    return { ok: false, error: "status must be in, out, or tentative" };
}
