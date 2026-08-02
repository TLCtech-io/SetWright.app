// Coerce a set-note write: { songId, note }. The songId must be a known song; the
// note is trimmed and length-capped. An empty note clears the annotation.

type Result =
    | { ok: true; value: { songId: string; note: string } }
    | { ok: false; error: string };

const MAX_LENGTH = 280;

export function coerceNote(raw: unknown, validSongIds: Set<string>): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;
    const songId = typeof r.songId === "string" ? r.songId : "";
    if (!validSongIds.has(songId)) return { ok: false, error: "unknown song" };
    // A wrong-typed note (e.g. a number) is a malformed payload, not an instruction to clear the
    // annotation. Reject it; only a string (trimmed/capped), an explicit empty string, or an absent
    // note clears. (Strict-coercion parity with castingInput/availability — a mistype must not delete.)
    if (r.note !== undefined && r.note !== null && typeof r.note !== "string") {
        return { ok: false, error: "note must be a string" };
    }
    const note =
        typeof r.note === "string" ? r.note.trim().slice(0, MAX_LENGTH) : "";
    return { ok: true, value: { songId, note } };
}
