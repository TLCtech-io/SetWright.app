// Coerce a segue write: { songId, seconds }. The songId must be a known song; seconds
// is a non-negative integer (0 = attacca), capped to a sane max, or null to clear the
// override (falling back to the event's per-song padding).

type Result =
    | { ok: true; value: { songId: string; seconds: number | null } }
    | { ok: false; error: string };

const MAX_SECONDS = 600;

export function coerceTransition(
    raw: unknown,
    validSongIds: Set<string>,
): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;
    const songId = typeof r.songId === "string" ? r.songId : "";
    if (!validSongIds.has(songId)) return { ok: false, error: "unknown song" };
    // A wrong-typed seconds (e.g. the string "30") is a malformed payload, not an instruction to clear
    // the segue. Reject it; only a non-negative number sets the override, and an explicit null (or an
    // absent seconds) clears it back to the event's per-song padding.
    if (
        r.seconds !== undefined &&
        r.seconds !== null &&
        !(
            typeof r.seconds === "number" &&
            Number.isFinite(r.seconds) &&
            r.seconds >= 0
        )
    ) {
        return {
            ok: false,
            error: "seconds must be a non-negative number or null",
        };
    }
    const seconds =
        typeof r.seconds === "number"
            ? Math.min(MAX_SECONDS, Math.round(r.seconds))
            : null;
    return { ok: true, value: { songId, seconds } };
}
