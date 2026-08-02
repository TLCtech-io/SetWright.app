// Coercers for the rehearsal-planner write routes: prep targets, the agenda, and
// the record. These are REPLACE writes, so they follow the coerceAvailability rule: a
// malformed entry, an unknown id, an over-cap array, or a bad field is REJECTED (returns
// null -> the route answers 400) rather than silently dropped, because a silent drop would
// delete the omitted existing rows. Only a duplicate is a harmless normalization, and an
// explicit empty array still clears the list. Kept here (not inline in the routes) so the
// rules are unit-tested alongside the other coercers.

import { MAX_FORM_ITEMS } from "./limits";
import type { RehearsalAgendaItem } from "./db";

const AGENDA_REASONS = new Set([
    "coverage-risk",
    "learning-gap",
    "stale",
    "upcoming-gig",
]);
const NOTE_MAX = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar date, not just regex-shaped. Date.parse rolls invalid days over
// (2026-02-30 -> Mar 2) instead of failing, and Postgres's date type rejects the raw string
// with a 500, so round-trip through Date and require it to come back unchanged.
export function isRealIsoDate(s: string): boolean {
    if (!ISO_DATE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// prep targets: a bare array of song ids under { songIds }.
export function coercePrepSongIds(
    raw: unknown,
    validSongIds: Set<string>,
): string[] | null {
    if (raw === null || typeof raw !== "object") return null;
    const ids = (raw as { songIds?: unknown }).songIds;
    if (!Array.isArray(ids)) return null;
    if (ids.length > MAX_FORM_ITEMS) return null;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (typeof id !== "string" || !validSongIds.has(id)) return null; // malformed / unknown: reject
        if (seen.has(id)) continue; // duplicate: normalize
        seen.add(id);
        out.push(id);
    }
    return out;
}

// agenda: ordered items { songId, reason?, note? } under { items }.
export function coerceAgendaItems(
    raw: unknown,
    validSongIds: Set<string>,
): RehearsalAgendaItem[] | null {
    if (raw === null || typeof raw !== "object") return null;
    const items = (raw as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    if (items.length > MAX_FORM_ITEMS) return null;
    const out: RehearsalAgendaItem[] = [];
    const seen = new Set<string>();
    for (const it of items) {
        if (!it || typeof it !== "object") return null;
        const songId = (it as { songId?: unknown }).songId;
        if (typeof songId !== "string" || !validSongIds.has(songId))
            return null; // malformed / unknown: reject
        const reasonRaw = (it as { reason?: unknown }).reason;
        if (
            reasonRaw != null &&
            (typeof reasonRaw !== "string" || !AGENDA_REASONS.has(reasonRaw))
        )
            return null; // bad reason: reject
        const noteRaw = (it as { note?: unknown }).note;
        if (noteRaw != null && typeof noteRaw !== "string") return null; // bad note type: reject
        if (seen.has(songId)) continue; // duplicate: normalize
        seen.add(songId);
        out.push({
            songId,
            reason: reasonRaw ?? null,
            note:
                typeof noteRaw === "string" && noteRaw.trim()
                    ? noteRaw.trim().slice(0, NOTE_MAX)
                    : null,
        });
    }
    return out;
}

export interface RecordInput {
    date: string;
    rehearsedSongIds: string[];
    attendance: { memberId: string; present: boolean }[];
}

// record: { date, rehearsedSongIds, attendance }. date falls back to the rehearsal's own
// date when absent/invalid (a scalar with a natural default, not a replace-write); the two
// arrays are strict. attendance is a replace-write; rehearsedSongIds is an additive stamp
// but kept strict for consistency.
export function coerceRecordInput(
    raw: unknown,
    validSongIds: Set<string>,
    validMemberIds: Set<string>,
    fallbackDate: string | null,
): RecordInput | null {
    if (raw === null || typeof raw !== "object") return null;
    const body = raw as {
        date?: unknown;
        rehearsedSongIds?: unknown;
        attendance?: unknown;
    };

    const rawDate =
        typeof body.date === "string" && isRealIsoDate(body.date)
            ? body.date
            : null;
    const date = rawDate ?? fallbackDate;
    if (date === null) return null;

    if (
        !Array.isArray(body.rehearsedSongIds) ||
        !Array.isArray(body.attendance)
    )
        return null;
    if (
        body.rehearsedSongIds.length > MAX_FORM_ITEMS ||
        body.attendance.length > MAX_FORM_ITEMS
    )
        return null;

    const songSeen = new Set<string>();
    const rehearsedSongIds: string[] = [];
    for (const id of body.rehearsedSongIds) {
        if (typeof id !== "string" || !validSongIds.has(id)) return null; // malformed / unknown: reject
        if (songSeen.has(id)) continue;
        songSeen.add(id);
        rehearsedSongIds.push(id);
    }

    const memSeen = new Set<string>();
    const attendance: { memberId: string; present: boolean }[] = [];
    for (const a of body.attendance) {
        if (!a || typeof a !== "object") return null;
        const memberId = (a as { memberId?: unknown }).memberId;
        const present = (a as { present?: unknown }).present;
        if (
            typeof memberId !== "string" ||
            !validMemberIds.has(memberId) ||
            typeof present !== "boolean"
        )
            return null; // reject
        if (memSeen.has(memberId)) continue; // duplicate: normalize
        memSeen.add(memberId);
        attendance.push({ memberId, present });
    }

    return { date, rehearsedSongIds, attendance };
}
