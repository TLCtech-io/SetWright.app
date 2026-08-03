// Row -> domain mappers for the Supabase adapter. Postgres columns are snake_case
// and tenancy/provenance-laden; these project each row onto the exact shape the mock
// returns (the shapes the routes and pages already consume), so swapping the data
// source changes nothing downstream. The `: Repository` annotation on the adapter is
// what guarantees these stay in lockstep with the mock.

import type { KeySig } from "@repertoire/core";
import type {
    EventRow,
    EventTypeRow,
    MemberRow,
    AttendanceItem,
    MockCasting,
    MockPart,
    PaddingProfileRow,
    PlaygroundMeta,
    RehearsalAgendaItem,
    SongRow,
    TagRow,
    VoicePartRow,
} from "../db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** A key signature is null unless both halves are present (mirrors the schema CHECK). */
export function keySig(
    fifths: number | null,
    mode: string | null,
): KeySig | null {
    if (
        fifths === null ||
        fifths === undefined ||
        mode === null ||
        mode === undefined
    )
        return null;
    return { fifths, mode: mode as KeySig["mode"] };
}

// PostgREST embed: a song with its tags, joined through song_tag -> tag.
export const SONG_SELECT = "*, song_tag(tag(name, category))";

export function toSongRow(r: Row): SongRow {
    return {
        id: r.id,
        publicId: r.public_id,
        title: r.title,
        startKey: keySig(r.start_key_fifths, r.start_key_mode),
        endKey: keySig(r.end_key_fifths, r.end_key_mode),
        startTempoBpm: r.start_tempo_bpm,
        endTempoBpm: r.end_tempo_bpm,
        durationSeconds: r.duration_seconds,
        isExplicit: r.is_explicit,
        usesAccompaniment: r.uses_accompaniment,
        intensity: r.intensity,
        tags: (r.song_tag ?? []).map((st: Row) => ({
            name: st.tag.name,
            category: st.tag.category,
        })),
        assessedReadiness: r.assessed_readiness,
        bookStatus: r.book_status,
        lastPerformed: r.last_performed,
        status: r.status,
        arranger: r.arranger,
        chartRef: r.chart_ref,
        lastRehearsed: r.last_rehearsed,
        startPitch: r.start_pitch,
    };
}

export function toMockPart(r: Row): MockPart {
    return {
        id: r.id,
        songId: r.song_id,
        isRequired: r.is_required,
        countNeeded: r.count_needed,
        label: r.label ?? "",
        voicePartId: r.voice_part_id,
        isSolo: r.is_solo,
        rangeLowMidi: r.range_low,
        rangeHighMidi: r.range_high,
        sortOrder: r.sort_order,
    };
}

// Castings are read through casting_visible, which nulls another member's
// self-reported confidence for non-directors and exposes director_assessed /
// learned_at only to a director.
export function toMockCasting(r: Row): MockCasting {
    return {
        partId: r.part_id,
        memberId: r.member_id,
        isPrimary: r.is_primary,
        confidence: r.self_reported_confidence ?? null,
        directorAssessed: r.director_assessed ?? null,
        learnedAt: r.learned_at ?? null,
    };
}

export function toTagRow(r: Row): TagRow {
    return {
        id: r.id,
        name: r.name,
        category: r.category,
        sortOrder: r.sort_order,
    };
}

export function toVoicePartRow(r: Row): VoicePartRow {
    return {
        id: r.id,
        label: r.label,
        sortOrder: r.sort_order,
        isPitched: r.is_pitched,
        nominalLowMidi: r.nominal_low,
        nominalHighMidi: r.nominal_high,
    };
}

export function toPaddingProfileRow(r: Row): PaddingProfileRow {
    return {
        id: r.id,
        name: r.name,
        perSongSeconds: r.per_song_seconds,
        perSetSeconds: r.per_set_seconds,
    };
}

// Embeds event_type_tag(effect, tag(name)); the prefer/exclude rules are stored as
// names (the mock convention), split out of the join here.
export const EVENT_TYPE_SELECT = "*, event_type_tag(effect, tag(name))";
export function toEventTypeRow(r: Row): EventTypeRow {
    const rules: Row[] = r.event_type_tag ?? [];
    return {
        id: r.id,
        name: r.name,
        sortOrder: r.sort_order,
        paddingProfileId: r.padding_profile_id,
        defaultAllowsOnBook: r.default_allows_on_book,
        defaultAllowsExplicit: r.default_allows_explicit,
        defaultAllowsAccompaniment: r.default_allows_accompaniment,
        excludeTags: rules
            .filter((x) => x.effect === "exclude")
            .map((x) => x.tag.name),
        preferTags: rules
            .filter((x) => x.effect === "prefer")
            .map((x) => x.tag.name),
        requireTags: rules
            .filter((x) => x.effect === "require")
            .map((x) => x.tag.name),
    };
}

// Embeds an event's RSVPs and its prefer/exclude tag rules. resolved is the event's
// own snapshotted policy + padding columns; excludeTags/preferTags are tag NAMES (the
// mock projection of event_tag), and availability is the RSVP list scoped to the event.
export const EVENT_SELECT =
    "*, availability(member_id, status), event_tag(effect, tag(name))";
export function toEventRow(r: Row): EventRow {
    const evTags: Row[] = r.event_tag ?? [];
    return {
        id: r.id,
        publicId: r.public_id,
        name: r.name,
        venue: r.venue,
        status: r.status,
        kind: r.kind,
        eventTypeId: r.event_type_id,
        resolved: {
            id: r.id,
            eventDate: r.event_date,
            targetDurationSeconds: r.target_duration_seconds,
            maxDurationSeconds: r.max_duration_seconds,
            allowsOnBook: r.allows_on_book,
            allowsExplicit: r.allows_explicit,
            allowsAccompaniment: r.allows_accompaniment,
            padding: {
                perSongSeconds: r.per_song_seconds,
                perSetSeconds: r.per_set_seconds,
            },
        },
        availability: (r.availability ?? []).map((a: Row) => ({
            memberId: a.member_id,
            status: a.status,
        })),
        excludeTags: evTags
            .filter((t) => t.effect === "exclude")
            .map((t) => t.tag.name),
        preferTags: evTags
            .filter((t) => t.effect === "prefer")
            .map((t) => t.tag.name),
        requireTags: evTags
            .filter((t) => t.effect === "require")
            .map((t) => t.tag.name),
    };
}

// Embeds a program's ordered items + anchors (schema: program + program_item). songIds
// is the arrangement (by position); open/close are the pinned anchor songs.
export const PROGRAM_SELECT = "*, program_item(song_id, position, pin)";
export function toPlaygroundMeta(r: Row): PlaygroundMeta {
    const items: Row[] = (r.program_item ?? [])
        .slice()
        .sort((a: Row, b: Row) => a.position - b.position);
    return {
        id: r.id,
        publicId: r.public_id,
        name: r.name,
        songIds: items.map((i) => i.song_id),
        open: items.find((i) => i.pin === "open")?.song_id ?? null,
        close: items.find((i) => i.pin === "close")?.song_id ?? null,
    };
}

// The rehearsal agenda: order by position on the caller. reason/note are nullable.
export const REHEARSAL_ITEM_SELECT = "song_id, position, reason, note";
export function toRehearsalAgendaItem(r: Row): RehearsalAgendaItem {
    return {
        songId: r.song_id,
        reason: r.reason ?? null,
        note: r.note ?? null,
    };
}

// Recorded attendance: who was present at an event.
export const ATTENDANCE_SELECT = "member_id, present";
export function toAttendanceItem(r: Row): AttendanceItem {
    return { memberId: r.member_id, present: r.present };
}

// Embeds member_voice_part(voice_part_id, is_primary_section) as the member's sections.
// Invite state lives in the director-only member_invite side table, embedded here. RLS
// returns it only to a director; a plain member gets an empty embed, so inviteEmail/invitedAt read
// as null for them — the masking is the database's, not the projection's.
export const MEMBER_SELECT =
    "*, member_voice_part(voice_part_id, is_primary_section), member_invite(invite_email, invited_at, declined_at)";
export function toMemberRow(r: Row): MemberRow {
    return {
        id: r.id,
        publicId: r.public_id,
        displayName: r.display_name,
        role: r.permission_tier,
        status: r.status,
        singing: r.is_singing,
        sections: (r.member_voice_part ?? []).map((s: Row) => ({
            voicePartId: s.voice_part_id,
            isPrimary: s.is_primary_section,
        })),
        rangeLowMidi: r.vocal_range_low,
        rangeHighMidi: r.vocal_range_high,
        claimed: r.user_id != null,
        // The embedded side table is a to-one relationship PostgREST returns as an array (0 or 1 rows,
        // RLS-scoped to a director). A member's empty embed leaves these null.
        inviteEmail:
            (Array.isArray(r.member_invite)
                ? r.member_invite[0]
                : r.member_invite
            )?.invite_email ?? null,
        invitedAt:
            (Array.isArray(r.member_invite)
                ? r.member_invite[0]
                : r.member_invite
            )?.invited_at ?? null,
        inviteDeclinedAt:
            (Array.isArray(r.member_invite)
                ? r.member_invite[0]
                : r.member_invite
            )?.declined_at ?? null,
    };
}
