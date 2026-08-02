// Coerce an untrusted self-confidence payload: which part, and the confidence level (one of
// solid/shaky/learning, or null/empty to un-report). Mirrors the member-owned column the
// set_my_confidence RPC writes.
import type { Confidence } from "@repertoire/core";
import { UUID_RE } from "./repository";

const LEVELS: Confidence[] = ["solid", "shaky", "learning"];

type Result =
    | { ok: true; partId: string; confidence: Confidence | null }
    | { ok: false; error: string };

export function coerceConfidence(raw: unknown): Result {
    const r = (raw ?? {}) as Record<string, unknown>;
    const partId = typeof r.partId === "string" ? r.partId : "";
    // partId feeds a uuid-typed column comparison; a non-uuid would reach Postgres as a bad cast
    // (22P02) and 500. Reject a malformed id as a clean 400 here, matching badPathUuid for path ids.
    if (!partId || !UUID_RE.test(partId))
        return { ok: false, error: "partId is required" };

    const c = r.confidence;
    if (c === null || c === "" || c === undefined)
        return { ok: true, partId, confidence: null };
    if (LEVELS.includes(c as Confidence))
        return { ok: true, partId, confidence: c as Confidence };
    return {
        ok: false,
        error: "confidence must be solid, shaky, learning, or empty",
    };
}
