// A sample hydration payload, the JSON hydrate_draft_input would return for a
// small ensemble. Two singers cover every song, one song is holiday-tagged so
// the context fold can drop it, and the keys and intensities give the sequencer
// something to order.

import type {
    Availability,
    Casting,
    Member,
    Part,
    ResolvedEvent,
    Song,
    Tag,
    TagCategory,
} from "@repertoire/core";
import type {
    HydrationPayload,
    HydrationSource,
    SetlistLocks,
    SetlistSource,
} from "../src/index.js";

const members: Member[] = [
    { id: "m1", displayName: "Mara" },
    { id: "m2", displayName: "Nico" },
];

const availability: Availability[] = [
    { memberId: "m1", status: "in" },
    { memberId: "m2", status: "in" },
];

const event: ResolvedEvent = {
    id: "ev1",
    eventDate: "2026-07-01",
    targetDurationSeconds: 900,
    maxDurationSeconds: null,
    allowsOnBook: true,
    allowsExplicit: false,
    allowsAccompaniment: true,
    padding: { perSongSeconds: 30, perSetSeconds: 60 },
};

const TAG_CATEGORY: Record<string, TagCategory> = {
    upbeat: "groove",
    holiday: "occasion",
};

function toTags(names: string[]): Tag[] {
    return names.map((name) => ({
        name,
        category: TAG_CATEGORY[name] ?? null,
    }));
}

function song(
    id: string,
    fifths: number,
    tempo: number,
    dur: number,
    intensity: number,
    tagNames: string[],
): Song {
    return {
        id,
        title: id,
        startKey: { fifths, mode: "major" },
        endKey: null,
        startTempoBpm: tempo,
        endTempoBpm: null,
        durationSeconds: dur,
        isExplicit: false,
        usesAccompaniment: false,
        intensity,
        tags: toTags(tagNames),
        assessedReadiness: "performance-ready",
        bookStatus: "off-book",
        lastPerformed: null,
        lastRehearsed: null,
    };
}

// Two required single-seat parts per song: m1 leads, m2 takes bass.
function partsFor(songId: string): Part[] {
    return [
        {
            id: `${songId}-a`,
            songId,
            isRequired: true,
            countNeeded: 1,
            label: "Lead",
        },
        {
            id: `${songId}-b`,
            songId,
            isRequired: true,
            countNeeded: 1,
            label: "Bass",
        },
    ];
}

function castingsFor(songId: string): Casting[] {
    return [
        {
            partId: `${songId}-a`,
            memberId: "m1",
            isPrimary: true,
            confidence: "solid",
            directorAssessed: null,
        },
        {
            partId: `${songId}-b`,
            memberId: "m2",
            isPrimary: false,
            confidence: "solid",
            directorAssessed: null,
        },
    ];
}

export function payload(
    over: Partial<HydrationPayload> = {},
): HydrationPayload {
    const songs = [
        song("s1", 0, 120, 180, 4, ["upbeat"]),
        song("s2", 1, 90, 200, 3, ["holiday"]),
        song("s3", 3, 130, 170, 5, []),
    ];
    return {
        event,
        members,
        availability,
        songs,
        parts: songs.flatMap((s) => partsFor(s.id)),
        castings: songs.flatMap((s) => castingsFor(s.id)),
        excludeTags: [],
        preferTags: [],
        requireTags: [],
        ...over,
    };
}

/** A HydrationSource that returns a fixed raw document. */
export function sourceOf(raw: unknown): HydrationSource {
    return { hydrate: async () => raw };
}

/**
 * The base payload plus s9, a dormant song below the default readiness floor.
 * A plain draft drops it at readiness; a keep pin forces it in. It carries no
 * parts, so it is trivially feasible and the only thing keeping it out is the
 * floor.
 */
export function payloadWithDormant(): HydrationPayload {
    const base = payload();
    const dormant: Song = {
        id: "s9",
        title: "s9",
        startKey: { fifths: 0, mode: "major" },
        endKey: null,
        startTempoBpm: 100,
        endTempoBpm: null,
        durationSeconds: 150,
        isExplicit: false,
        usesAccompaniment: false,
        intensity: 3,
        tags: [],
        assessedReadiness: "dormant",
        bookStatus: "off-book",
        lastPerformed: null,
        lastRehearsed: null,
    };
    return { ...base, songs: [...base.songs, dormant] };
}

/** A locks document, defaulting to no pins on event ev1. */
export function locks(over: Partial<SetlistLocks> = {}): SetlistLocks {
    return {
        eventId: "ev1",
        opens: [],
        closes: [],
        keep: [],
        excluded: [],
        transitions: [],
        breaks: [],
        ...over,
    };
}

/** A SetlistSource serving a fixed payload and a fixed locks document. */
export function setlistSource(
    rawPayload: unknown,
    rawLocks: unknown,
): SetlistSource {
    return {
        hydrate: async () => rawPayload,
        hydrateLocks: async () => rawLocks,
    };
}
