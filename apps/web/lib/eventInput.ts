// Coerce untrusted event-form and RSVP payloads into clean shapes. Validates the
// policy fields, resolves context tags against the vocabulary, and (for RSVP)
// scopes statuses to the known roster and the three valid states.

import type { Availability, AvailabilityStatus } from "@repertoire/core";
import { DEFAULT_PADDING, type EventInput } from "./db";
import { MAX_FORM_ITEMS } from "./limits";
import { coerceTagRules } from "./tagRulesInput";

const STATUS: AvailabilityStatus[] = ["in", "out", "tentative"];

// Upper bounds so an event cannot ask the drafter to build an unbounded set or reserve absurd
// padding: a target longer than a full day, or per-song/per-set padding over an hour, is abuse,
// not a real booking. Clamps rather than rejects, so a fat-fingered value still saves sensibly.
const TARGET_MAX_SECONDS = 86_400; // 24 hours
const PADDING_MAX_SECONDS = 3_600; // 1 hour

type Result = { ok: true; value: EventInput } | { ok: false; error: string };

const posIntCappedOrNull = (v: unknown, max: number): number | null => {
    // Round BEFORE the positivity test: a fractional 0 < v < 0.5 passes `v > 0` but rounds to 0,
    // which violates the column's `> 0` CHECK and 500s. Round first, keep only a positive integer.
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const n = Math.round(v);
    return n > 0 ? Math.min(n, max) : null;
};
const nonNegIntCapped = (v: unknown, dflt: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.min(Math.round(v), max)
        : dflt;
const dateOrNull = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // Reject impossible calendar dates (e.g. 2026-13-40, 2026-02-30) by round-trip.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === mo - 1 &&
        dt.getUTCDate() === d
        ? v
        : null;
};
export function coerceEventInput(
    raw: unknown,
    vocab: Set<string>,
    typeIds: Set<string>,
): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) return { ok: false, error: "name is required" };

    // Provenance pointer only; an unknown type id drops to untyped.
    const eventTypeId =
        typeof r.eventTypeId === "string" && typeIds.has(r.eventTypeId)
            ? r.eventTypeId
            : null;

    // Precedence exclude > require > prefer, deduped and capped against the vocabulary (shared).
    const { excludeTags, preferTags, requireTags } = coerceTagRules(r, vocab);

    const venue =
        typeof r.venue === "string" && r.venue.trim() ? r.venue.trim() : null;
    const status = r.status === "cancelled" ? "cancelled" : "planned"; // default planned
    const kind = r.kind === "rehearsal" ? "rehearsal" : "gig"; // default gig; the write ignores it on edit (immutable)

    const targetDurationSeconds = posIntCappedOrNull(
        r.targetDurationSeconds,
        TARGET_MAX_SECONDS,
    );
    const maxDurationSeconds = posIntCappedOrNull(
        r.maxDurationSeconds,
        TARGET_MAX_SECONDS,
    );
    const perSetSeconds = nonNegIntCapped(
        r.perSetSeconds,
        DEFAULT_PADDING.perSetSeconds,
        PADDING_MAX_SECONDS,
    );
    // A per-set overhead that meets or exceeds the target leaves a negative fill budget, so the drafter
    // returns an empty, overhead-only set. Reject the contradictory config here rather than store it.
    if (
        targetDurationSeconds !== null &&
        perSetSeconds >= targetDurationSeconds
    ) {
        return {
            ok: false,
            error: "per-set overhead must be less than the target duration",
        };
    }
    // The hard cap is a ceiling, so it cannot sit below the target it caps (the schema check
    // mirrors this). Reject the contradiction with a friendly message before the DB does.
    if (
        maxDurationSeconds !== null &&
        targetDurationSeconds !== null &&
        maxDurationSeconds < targetDurationSeconds
    ) {
        return {
            ok: false,
            error: "the hard cap must be at least the target duration",
        };
    }

    return {
        ok: true,
        value: {
            name,
            venue,
            status,
            kind,
            eventTypeId,
            eventDate: dateOrNull(r.eventDate),
            targetDurationSeconds,
            maxDurationSeconds,
            allowsOnBook: r.allowsOnBook !== false, // default true
            allowsExplicit: r.allowsExplicit === true, // default false
            allowsAccompaniment: r.allowsAccompaniment !== false, // default true
            perSongSeconds: nonNegIntCapped(
                r.perSongSeconds,
                DEFAULT_PADDING.perSongSeconds,
                PADDING_MAX_SECONDS,
            ),
            perSetSeconds,
            excludeTags,
            preferTags,
            requireTags,
        },
    };
}

export function coerceAvailability(
    raw: unknown,
    validMemberIds: Set<string>,
): Availability[] | null {
    if (typeof raw !== "object" || raw === null) return null;
    const arr = (raw as { availability?: unknown }).availability;
    // A missing or non-array `availability` is a malformed body (-> 400), not an
    // instruction to wipe every RSVP. An explicit empty array is allowed.
    if (!Array.isArray(arr)) return null;
    if (arr.length > MAX_FORM_ITEMS) return null; // over-cap: reject, do not truncate

    // This is a REPLACE write, so it is strict: a malformed entry (not an object, unknown member, or
    // a bad status) is REJECTED rather than dropped — a silent drop would delete that member's RSVP.
    // Only a duplicate member is a harmless normalization. An explicit empty array still clears.
    const out: Availability[] = [];
    const seen = new Set<string>();
    for (const a of arr) {
        if (typeof a !== "object" || a === null) return null;
        const ar = a as Record<string, unknown>;
        const memberId = typeof ar.memberId === "string" ? ar.memberId : "";
        if (!validMemberIds.has(memberId)) return null; // unknown member: reject
        if (!STATUS.includes(ar.status as AvailabilityStatus)) return null; // bad status: reject
        if (seen.has(memberId)) continue; // duplicate: normalize
        seen.add(memberId);
        out.push({ memberId, status: ar.status as AvailabilityStatus });
    }
    return out;
}
