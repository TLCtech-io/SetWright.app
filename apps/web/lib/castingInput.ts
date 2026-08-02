// Coerce an untrusted casting payload into a clean, scoped Casting[]. This is a REPLACE write, so
// it is strict: a malformed entry (not an object, or referencing an unknown part/member) or an
// over-cap list is REJECTED (-> 400), never silently dropped — silently dropping an entry would
// delete its stored row. Only the harmless normalizations stay: dedupe (member, part) and at most
// one primary per part. An explicit empty array still clears.

import type { Confidence } from "@repertoire/core";
import type { CastingWrite } from "./db";
import { MAX_FORM_ITEMS } from "./limits";

const CONFIDENCE: Confidence[] = ["solid", "shaky", "learning"];

export function coerceCasting(
    raw: unknown,
    validPartIds: Set<string>,
    validMemberIds: Set<string>,
): CastingWrite[] | null {
    if (typeof raw !== "object" || raw === null) return null;
    const arr = (raw as { castings?: unknown }).castings;
    // Reject a missing/malformed list rather than coercing it to [] — an empty array
    // would REPLACE (wipe) the song's castings, so a junk payload must 400, not erase.
    if (!Array.isArray(arr)) return null;
    if (arr.length > MAX_FORM_ITEMS) return null; // over-cap: reject, do not truncate

    const out: CastingWrite[] = [];
    const seen = new Set<string>(); // partId:memberId, unique cover per part
    const primaryTaken = new Set<string>(); // one primary per part

    for (const c of arr) {
        if (typeof c !== "object" || c === null) return null;
        const r = c as Record<string, unknown>;
        const partId = typeof r.partId === "string" ? r.partId : "";
        const memberId = typeof r.memberId === "string" ? r.memberId : "";
        if (!validPartIds.has(partId) || !validMemberIds.has(memberId))
            return null; // unknown id: reject

        const key = `${partId}:${memberId}`;
        if (seen.has(key)) continue; // duplicate cover: a harmless normalization, not a dropped write
        seen.add(key);

        let isPrimary = r.isPrimary === true;
        if (isPrimary) {
            if (primaryTaken.has(partId)) isPrimary = false;
            else primaryTaken.add(partId);
        }
        const confidence = CONFIDENCE.includes(r.confidence as Confidence)
            ? (r.confidence as Confidence)
            : null;
        const directorAssessed = CONFIDENCE.includes(
            r.directorAssessed as Confidence,
        )
            ? (r.directorAssessed as Confidence)
            : null;

        out.push({ partId, memberId, isPrimary, confidence, directorAssessed });
    }
    return out;
}
