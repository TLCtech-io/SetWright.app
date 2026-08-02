// The gig call sheet. A read-only view of one event for a member —
// the header, their own RSVP, the frozen running order (with the songs they are cast on marked),
// their prep list for the night, and who else is coming. It reuses everything the console built:
// getPublishedSet (the frozen, member-visible order), attendanceGroups (names by section), and
// listMyCastings (the member's own parts). Every read here is member-safe: RLS scopes them to the
// caller, and the set reader only ever returns a performed or published set, never a live draft.

import { clockSeconds, keyLabel, tonicName } from "@repertoire/core";
import type { AvailabilityStatus, Confidence } from "@repertoire/core";
import type { EventKind, EventRow, MyCasting, SetlistStatus } from "./db";
import type { Repository } from "./repository";
import type { MyMembership } from "./ensembles";
import {
    attendanceGroups,
    type AttendanceGroup,
    type AttendanceMember,
} from "./attendanceGroups";
import {
    formatEventDate,
    formatKeyRange,
    formatSeconds,
    formatTempo,
    todayInTz,
} from "./format";

const DAY = 86_400_000;

// The member's own involvement on one set song: which line(s) they cover and whether any is a lead.
export interface CallSheetMine {
    parts: string[];
    isLead: boolean;
}

// One printed row of the running order. position 0 marks a break divider (breakRow set).
export interface CallSheetRow {
    position: number;
    title: string;
    keyText: string;
    pitch: string; // explicit start pitch, else the start key's tonic
    duration: string;
    note?: string; // the director's live staging note for this song, when set
    segue: boolean; // attacca into the next song
    mine: CallSheetMine | null; // set when the member is cast on this song
    breakRow?: { label: string; duration: string };
}

// The member's prep for one part they cover in the set: the pitch to blow, key, tempo, and their
// own self-report. A focused, gig-scoped slice of /me/parts.
export interface CallSheetPart {
    songId: string;
    songTitle: string;
    partLabel: string;
    isLead: boolean;
    isSolo: boolean;
    pitch: string | null;
    keyText: string;
    tempo: string;
    confidence: Confidence | null;
}

export interface CallSheetSet {
    setlistId: string;
    setName: string | null;
    status: SetlistStatus;
    performedDate: string | null; // set when the gig has happened, else null (a published-ahead set)
    rows: CallSheetRow[];
    total: string;
    songCount: number;
}

export interface CallSheetView {
    eventId: string;
    header: {
        name: string;
        kind: EventKind;
        dateLabel: string;
        venue: string | null;
        eventType: string | null;
        targetLabel: string | null;
        cancelled: boolean;
        daysUntil: number | null; // whole days from today to the date, null if undated or already past
        isPast: boolean; // the dated event has already happened, so RSVP no longer applies
    };
    myStatus: AvailabilityStatus | null;
    set: CallSheetSet | null; // the member-visible set, or null (a rehearsal, or a gig with nothing shared)
    isDraft: boolean; // the set is a shared LIVE draft (subject to change), not a published/performed record
    myParts: CallSheetPart[]; // the member's parts among the set's songs, in set order
    groups: AttendanceGroup[];
}

// The pitch a member blows to find their note: the song's explicit start pitch, else the start
// key's tonic (spelled per the key). The same rule the printable sheet and /me/parts use.
const pitchToBlow = (
    startPitch: string | null,
    startKey: MyCasting["startKey"],
): string | null => startPitch ?? (startKey ? tonicName(startKey) : null);

export async function buildCallSheetView(
    repo: Repository,
    event: EventRow,
    me: MyMembership,
): Promise<CallSheetView> {
    const [roster, voiceParts, eventTypes, settings, myCastings] =
        await Promise.all([
            repo.listRoster(),
            repo.listVoiceParts(),
            repo.listEventTypes(),
            repo.getEnsembleSettings(),
            repo.listMyCastings(),
        ]);

    const typeName = event.eventTypeId
        ? (eventTypes.find((t) => t.id === event.eventTypeId)?.name ?? null)
        : null;
    const today = todayInTz(settings.timezone);
    const date = event.resolved.eventDate;
    // Both parsed as UTC midnight, so the difference is clean whole days (same as lib/prep). Past
    // dates fall to null — the date label already carries "when", and "in -3 days" reads wrong.
    const daysUntil =
        date && date >= today
            ? Math.round((Date.parse(date) - Date.parse(today)) / DAY)
            : null;
    const isPast = !!date && date < today;

    // Who's coming: the active singing pool, projected to the safe fields the grouping reads (the
    // same pool the director's RSVP tally and the schedule page use, so the roll matches).
    const pool: AttendanceMember[] = roster
        .filter((m) => m.singing && m.status === "active")
        .map((m) => ({
            id: m.id,
            displayName: m.displayName,
            sections: m.sections,
        }));
    const groups = attendanceGroups(event.availability, pool, voiceParts);
    const myStatus =
        event.availability.find((a) => a.memberId === me.memberId)?.status ??
        null;

    // The member-visible set (gigs only): prefer the performed set (what happened), else the most
    // recently published one. getPublishedSet returns the frozen order.
    const metas =
        event.kind === "gig" ? await repo.listEventSetlists(event.id) : [];
    const visible = metas
        .filter((m) => m.status === "performed" || m.publishedAt != null)
        .sort((a, b) => {
            if ((a.status === "performed") !== (b.status === "performed"))
                return a.status === "performed" ? -1 : 1;
            return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
        });
    let pub = visible[0]
        ? await repo.getPublishedSet(visible[0].id)
        : undefined;

    // No published or performed set, but the director may be SHARING a live draft. Fall back to it
    // (the same shape, read from draft_order) and flag the view so the member sees a "draft, subject to
    // change" banner. A published or performed set always wins, so a frozen record is never masked.
    let isDraft = false;
    if (!pub && event.kind === "gig") {
        const sharedMeta = metas.find(
            (m) =>
                m.shareDraft &&
                m.status !== "performed" &&
                m.publishedAt == null,
        );
        if (sharedMeta) {
            pub = await repo.getSharedDraft(sharedMeta.id);
            isDraft = pub != null;
        }
    }

    let set: CallSheetSet | null = null;
    const myParts: CallSheetPart[] = [];
    if (pub) {
        const setSongIds = new Set(pub.songs.map((s) => s.id));
        // The member's castings among THIS set's songs, grouped by song (a member can cover more than
        // one line of a song). Orphan castings (songId '') never match a real set song, so they drop.
        const mineBySong = new Map<string, MyCasting[]>();
        for (const c of myCastings) {
            if (!setSongIds.has(c.songId)) continue;
            let list = mineBySong.get(c.songId);
            if (!list) {
                list = [];
                mineBySong.set(c.songId, list);
            }
            list.push(c);
        }

        const breakAt = new Map(pub.breaks.map((b) => [b.afterPosition, b]));
        const rows: CallSheetRow[] = [];
        pub.songs.forEach((song, i) => {
            const brk = breakAt.get(i + 1);
            const mineHere = mineBySong.get(song.id);
            rows.push({
                position: i + 1,
                title: song.title,
                keyText: song.startKey ? keyLabel(song.startKey) : "—",
                pitch:
                    song.startPitch ??
                    (song.startKey ? tonicName(song.startKey) : "—"),
                duration:
                    song.durationSeconds != null
                        ? formatSeconds(song.durationSeconds)
                        : "—",
                note: pub.notes[song.id],
                segue:
                    pub.transitions[song.id] === 0 &&
                    !brk &&
                    i < pub.songs.length - 1,
                mine: mineHere
                    ? {
                          parts: mineHere.map((c) => c.partLabel),
                          isLead: mineHere.some((c) => c.isLead),
                      }
                    : null,
            });
            if (brk) {
                rows.push({
                    position: 0,
                    title: "",
                    keyText: "",
                    pitch: "",
                    duration: "",
                    segue: false,
                    mine: null,
                    breakRow: {
                        label: brk.label,
                        duration: formatSeconds(brk.durationSeconds),
                    },
                });
            }
        });

        const unsetLength = pub.songs.some((s) => s.durationSeconds == null); // a floor when a length is unset
        const total =
            formatSeconds(
                clockSeconds(
                    pub.songs,
                    pub.padding,
                    new Map(Object.entries(pub.transitions)),
                    pub.breaks,
                ),
            ) + (unsetLength ? "+" : "");

        set = {
            setlistId: pub.setlistId,
            setName: pub.name,
            status: pub.status,
            performedDate: pub.performedDate,
            rows,
            total,
            songCount: pub.songs.length,
        };

        // The prep list: the member's own parts among the set songs, walked in set order.
        for (const song of pub.songs) {
            for (const c of mineBySong.get(song.id) ?? []) {
                myParts.push({
                    songId: song.id,
                    songTitle: c.songTitle,
                    partLabel: c.partLabel,
                    isLead: c.isLead,
                    isSolo: c.isSolo,
                    pitch: pitchToBlow(c.startPitch, c.startKey),
                    keyText: formatKeyRange(c.startKey, c.endKey),
                    tempo: formatTempo(c.startTempoBpm, c.endTempoBpm),
                    confidence: c.confidence,
                });
            }
        }
    }

    return {
        eventId: event.id,
        header: {
            name: event.name,
            kind: event.kind,
            dateLabel: formatEventDate(event.resolved.eventDate) ?? "Date TBD",
            venue: event.venue ?? null,
            eventType: typeName,
            targetLabel:
                event.resolved.targetDurationSeconds != null
                    ? `target ${formatSeconds(event.resolved.targetDurationSeconds)}`
                    : null,
            cancelled: event.status === "cancelled",
            daysUntil,
            isPast,
        },
        myStatus,
        set,
        isDraft,
        myParts,
        groups,
    };
}
