// The outcome of an optimistic-concurrency write (the "replace the whole collection"
// mutations: availability, breaks, casting, and a song's parts). The caller loads the
// parent entity's `version` token, sends it back as expectedVersion, and the write either
// succeeds (returning the new version) or fails because the parent vanished (not_found)
// or someone else wrote since the token was read (conflict → the route returns 409).
//
// The token is opaque: in supabase mode it is the parent row's updated_at (maintained by
// the moddatetime trigger); in mock mode it is a per-entity counter. Clients only compare
// and round-trip it, never interpret it.
export type WriteResult =
    | { ok: true; version: string }
    | { ok: false; reason: "not_found" | "conflict" };

/** The token a guarded write expects, pulled from a request body — or null if absent. */
export function readExpectedVersion(raw: unknown): string | null {
    if (typeof raw !== "object" || raw === null) return null;
    const v = (raw as { expectedVersion?: unknown }).expectedVersion;
    return typeof v === "string" && v ? v : null;
}

/** The message shown when a write loses an optimistic-concurrency race (HTTP 409). */
export const CONFLICT_MESSAGE =
    "This was changed somewhere else since you opened it. Reload and try again.";
