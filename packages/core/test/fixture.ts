// A small, realistic group used by the tests.
//
// Roster: three sopranos, two each of alto, tenor, bass, one VP specialist.
// Songs are shaped so each drafter stage has something to do: a VP number the
// missing percussionist makes infeasible, an on-book hymn, an explicit track,
// a needs-polish chart, and a half-step key pair (Db against C).

import type {
    Availability,
    Casting,
    ContextPolicy,
    Member,
    Part,
    ResolvedEvent,
    Song,
    Tag,
    TagCategory,
} from "../src/index.js";

// The ensemble's tag vocabulary and what each tag is. upbeat drives groove
// variety, ballad mood, sacred is content (gateable), holiday occasion.
const TAG_CATEGORY: Record<string, TagCategory> = {
    upbeat: "groove",
    ballad: "mood",
    sacred: "content",
    holiday: "occasion",
};

function toTags(names: string[]): Tag[] {
    return names.map((name) => ({
        name,
        category: TAG_CATEGORY[name] ?? null,
    }));
}

// --- Members ---

export const members: Member[] = [
    { id: "alice", displayName: "Alice" },
    { id: "bea", displayName: "Bea" },
    { id: "bree", displayName: "Bree" },
    { id: "cory", displayName: "Cory" },
    { id: "dana", displayName: "Dana" },
    { id: "evan", displayName: "Evan" },
    { id: "finn", displayName: "Finn" },
    { id: "gita", displayName: "Gita" },
    { id: "hank", displayName: "Hank" },
    { id: "victor", displayName: "Victor" }, // the only VP cover
];

// --- Songs and parts ---

function mkSong(
    id: string,
    title: string,
    fifths: number,
    startTempoBpm: number,
    durationSeconds: number,
    intensity: number | null,
    tagNames: string[],
    assessedReadiness: Song["assessedReadiness"],
    bookStatus: Song["bookStatus"],
    isExplicit = false,
): Song {
    return {
        id,
        title,
        startKey: { fifths, mode: "major" },
        endKey: null,
        startTempoBpm,
        endTempoBpm: null,
        durationSeconds,
        isExplicit,
        usesAccompaniment: false,
        intensity,
        tags: toTags(tagNames),
        assessedReadiness,
        bookStatus,
        lastPerformed: null,
        lastRehearsed: null,
    };
}

function mkPart(
    id: string,
    songId: string,
    label: string,
    countNeeded: number,
): Part {
    return { id, songId, label, countNeeded, isRequired: true };
}

function mkCasting(
    partId: string,
    memberId: string,
    confidence: Casting["confidence"] = "solid",
    isPrimary = false,
    directorAssessed: Casting["directorAssessed"] = null,
): Casting {
    return { partId, memberId, isPrimary, confidence, directorAssessed };
}

const SOP = ["alice", "bea", "bree"];
const ALT = ["cory", "dana"];
const TEN = ["evan", "finn"];
const BAS = ["gita", "hank"];

// Standard SATB block for a song: four section parts and their castings.
function satb(songId: string): { parts: Part[]; castings: Casting[] } {
    const parts: Part[] = [
        mkPart(`${songId}-S`, songId, "Soprano", 2),
        mkPart(`${songId}-A`, songId, "Alto", 2),
        mkPart(`${songId}-T`, songId, "Tenor", 2),
        mkPart(`${songId}-B`, songId, "Bass", 2),
    ];
    const castings: Casting[] = [
        ...SOP.map((m) => mkCasting(`${songId}-S`, m)),
        ...ALT.map((m) => mkCasting(`${songId}-A`, m)),
        ...TEN.map((m) => mkCasting(`${songId}-T`, m)),
        ...BAS.map((m) => mkCasting(`${songId}-B`, m)),
    ];
    return { parts, castings };
}

const songList: Song[] = [];
const parts: Part[] = [];
const castings: Casting[] = [];

function addSong(s: Song, extra?: { parts?: Part[]; castings?: Casting[] }) {
    songList.push(s);
    const block = satb(s.id);
    parts.push(...block.parts, ...(extra?.parts ?? []));
    castings.push(...block.castings, ...(extra?.castings ?? []));
}

// S1: clean performance-ready opener. C major, intensity 4 (driving, opener-fit).
addSong(
    mkSong(
        "s1",
        "Opening Number",
        0,
        120,
        180,
        4,
        ["upbeat"],
        "performance-ready",
        "off-book",
    ),
);

// S2: ballad with a solo, Alice the solid lead. G major, intensity 2 (gentle).
// Alice is also a soprano, so the matcher must give the soprano seats to Bea and Bree.
addSong(
    mkSong(
        "s2",
        "Ballad of Rest",
        1,
        70,
        210,
        2,
        ["sacred", "ballad"],
        "performance-ready",
        "off-book",
    ),
    {
        parts: [mkPart("s2-SOLO", "s2", "Solo", 1)],
        castings: [mkCasting("s2-SOLO", "alice", "solid", true)],
    },
);

// S3: VP number. Only Victor covers VP, and he is out for this event. A major,
// intensity 5 (barnburner).
addSong(
    mkSong(
        "s3",
        "Beatbox Banger",
        3,
        132,
        200,
        5,
        ["upbeat"],
        "performance-ready",
        "off-book",
    ),
    {
        parts: [mkPart("s3-VP", "s3", "VP", 1)],
        castings: [mkCasting("s3-VP", "victor", "solid", true)],
    },
);

// S4: solid, but on-book only. F major, intensity 2.
addSong(
    mkSong(
        "s4",
        "On the Book Hymn",
        -1,
        80,
        240,
        2,
        ["sacred"],
        "performance-ready",
        "on-book",
    ),
);

// S5: Db major, half a step from S1's C. Intensity 4. Used for the seam cost.
addSong(
    mkSong(
        "s5",
        "Half Step Up",
        -5,
        118,
        190,
        4,
        ["upbeat"],
        "performance-ready",
        "off-book",
    ),
);

// S6: needs-polish, and unrated intensity (null), to exercise no-signal handling.
addSong(
    mkSong(
        "s6",
        "Still Learning This",
        0,
        100,
        180,
        null,
        ["sacred"],
        "needs-polish",
        "off-book",
    ),
);

// S7: explicit content. isExplicit is a policy field now, not a tag. Intensity 5.
addSong(
    mkSong(
        "s7",
        "Explicit Track",
        4,
        128,
        175,
        5,
        ["upbeat"],
        "performance-ready",
        "off-book",
        true,
    ),
);

export const songs = songList;
export { parts, castings };

// --- Event and availability ---

// Church service: on-book allowed, explicit not. 22 minute target, 2 minute
// one-time overhead, 45 seconds per song.
export const event: ResolvedEvent = {
    id: "ev1",
    eventDate: "2026-06-28",
    targetDurationSeconds: 1320,
    maxDurationSeconds: null,
    allowsOnBook: true,
    allowsExplicit: false,
    allowsAccompaniment: true,
    padding: { perSongSeconds: 45, perSetSeconds: 120 },
};

// Explicit is gated natively now, so it is not an exclude tag. Sacred earns a
// soft boost for a service.
export const churchContext: ContextPolicy = {
    excludeTags: [],
    preferTags: ["sacred"],
    requireTags: [],
};

const present = [
    "alice",
    "bea",
    "bree",
    "cory",
    "dana",
    "evan",
    "finn",
    "gita",
    "hank",
];

export const availability: Availability[] = [
    ...present.map<Availability>((m) => ({ memberId: m, status: "in" })),
    { memberId: "victor", status: "out" },
];
