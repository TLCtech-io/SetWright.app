// The writable in-memory mock database. One ensemble's worth of normalized data
// (songs, parts, castings, members, tags, events, setlists), seeded once and
// mutated in place for the life of the dev server. It stands in for the Postgres
// tables behind RLS; hydratePayload mirrors what hydrate_draft_input.sql projects.
//
// The mock data source, selected by DATA_SOURCE; in production, reads/writes go
// through the client's RLS-scoped Supabase queries instead. Data resets on restart,
// by design.

import type {
    AssessedReadiness,
    Availability,
    AvailabilityStatus,
    BookStatus,
    Casting,
    Confidence,
    KeySig,
    Member,
    Part,
    ResolvedEvent,
    SetBreak,
    Song,
    Tag,
} from "@repertoire/core";
import { midi, normalizeBreaks } from "@repertoire/core";
import type { HydrationPayload } from "@repertoire/api";
import type { PinState } from "./types";
import { EMPTY_PINS } from "./types";
import type { WriteResult } from "./writeResult";

export type MemberRole = "director" | "section_leader" | "member";
export type MemberStatus = "active" | "inactive"; // 'inactive' = left the group (schema)

// The ensemble's section vocabulary (schema: voice_part). Tenant-defined and
// editable: a director can add, rename, reorder (sortOrder), and delete sections.
// The drafter never sees it — voice_part_id resolves to a part label in hydrate
// and coverage is casting-only — so it lives entirely mock-side.
export interface VoicePartRow {
    id: string;
    label: string;
    sortOrder: number;
    isPitched: boolean; // false for vocal percussion (schema: is_pitched)
    nominalLowMidi: number | null; // the section's typical range, advisory
    nominalHighMidi: number | null;
}

// A member's link to a section (schema: member_voice_part). isPrimary marks the
// member's one home section (schema: is_primary_section, at most one per member).
export interface MemberSection {
    voicePartId: string;
    isPrimary: boolean;
}

// The ensemble's tag vocabulary row (schema: tag). category is one of the fixed
// schema enum values (or null); sortOrder is the display order. Songs and events
// store tags by their resolved name (the mock's projection of song_tag/event_tag),
// so a rename/recategorize/delete cascades into those copies.
export interface TagRow {
    id: string;
    name: string;
    category: Tag["category"];
    sortOrder: number;
}

// A reusable padding preset (schema: padding_profile). An event type references one
// as its default; an event snapshots its resolved values at create.
export interface PaddingProfileRow {
    id: string;
    name: string;
    perSongSeconds: number;
    perSetSeconds: number;
}

// An event type (schema: event_type) — a create-time TEMPLATE. It carries a default
// padding profile, policy flags, and standing tag rules that are SNAPSHOTTED onto an
// event at create / apply-defaults. Tag rules are stored as names (mock convention,
// like events/songs), so a tag rename cascades to them and keeps them current.
export interface EventTypeRow {
    id: string;
    name: string;
    sortOrder: number;
    paddingProfileId: string | null;
    defaultAllowsOnBook: boolean;
    defaultAllowsExplicit: boolean;
    defaultAllowsAccompaniment: boolean;
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}

// The resolved defaults a type stamps onto an event (padding resolved from the
// profile, else DEFAULT_PADDING). What the event form prefills / re-applies.
export interface ResolvedEventTypePreset {
    allowsOnBook: boolean;
    allowsExplicit: boolean;
    allowsAccompaniment: boolean;
    perSongSeconds: number;
    perSetSeconds: number;
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}

// The full roster record. The drafter only reads { id, displayName } (coverage
// comes from casting), so role, voice parts, and range live here, not in core's
// Member, and are projected away in hydratePayload.
export interface MemberRow extends Member {
    // The URL token for this member (roster deep links). Never replaces id (the uuid).
    publicId: string;
    role: MemberRole;
    status: MemberStatus;
    // A non-singing member keeps platform access (their role) but is never pulled
    // into a draft: excluded from the available pool, RSVPs, and casting. Orthogonal
    // to role and status (a non-singing director is valid).
    singing: boolean;
    // Which sections this member can cover, with one optionally marked home. The
    // mock's projection of member_voice_part rows.
    sections: MemberSection[];
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
    // The invite/claim flow. `claimed` mirrors "member.user_id is bound":
    // the seat belongs to a real signed-in account. A seat is PENDING while inviteEmail is
    // set and unclaimed; on claim, inviteEmail clears. So three states: claimed (active
    // login), inviteEmail set (invite pending), or neither (a seat with no login yet).
    // Mock mode has no real auth, so these are display-only.
    claimed: boolean;
    inviteEmail: string | null;
    invitedAt: string | null;
}

export type SongStatus = "active" | "archived";
// SongRow extends core's Song with provenance/admin fields the drafter does not
// read (they stay off the core type, projected away in hydratePayload).
export type SongRow = Song & {
    // The URL token for this song. Web/routing only, kept off the core Song, so hydratePayload's
    // stripStatus drops it. Never replaces id: id is the uuid, publicId is the shareable token.
    publicId: string;
    status: SongStatus;
    arranger: string | null;
    chartRef: string | null;
    lastRehearsed: string | null; // YYYY-MM-DD
    startPitch: string | null; // explicit pitch to blow, a pitch class like 'C#'; null = derive from the start key
    version?: string; // optimistic-concurrency token for casting / parts writes (getSong only)
};

// MockPart extends core's Part with the section/solo/range the schema carries but
// the drafter ignores (coverage comes from casting). Projected to Part on hydrate.
export type MockPart = Part & {
    voicePartId: string | null; // section id from the vocab; null for a solo
    isSolo: boolean;
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
    sortOrder: number; // display order within the song; the drafter ignores it
};

// MockCasting extends core Casting with learned_at: the date the cover was confirmed
// solid (null while not solid). director_assessed now lives on core Casting (the
// readiness stage reads it, so hydratePayload projects it); learned_at stays mock-only
// until it has a consumer.
export type MockCasting = Casting & {
    learnedAt: string | null;
};
// The shape the casting editor sends: a full core Casting (including the director's
// assessment). learnedAt is derived on write, never sent by the client.
export type CastingWrite = Casting;

export type EventStatus = "planned" | "cancelled";
export type EventKind = "gig" | "rehearsal"; // a rehearsal is an event of kind 'rehearsal'
export type SetlistStatus = "draft" | "final" | "performed";

export interface EventRow {
    id: string;
    // The URL token for this event (the shared event-detail route). Never replaces id (the uuid).
    publicId: string;
    name: string;
    venue: string | null;
    status: EventStatus;
    kind: EventKind; // set at create, not edited after; filters the gig-only seams
    eventTypeId: string | null; // provenance/grouping: the type this event was created from
    resolved: ResolvedEvent;
    availability: Availability[];
    excludeTags: string[]; // event policy context: drop songs carrying any of these
    preferTags: string[]; // event policy context: nudge songs carrying any of these
    requireTags: string[]; // set-level mandate: the drafted set must include one song carrying each
    version?: string; // optimistic-concurrency token for availability writes (getEvent only)
}

interface SetlistRow {
    eventId: string;
    programId: string | null; // the program this set was instantiated from, if any (schema: setlist.program_id)
    name: string | null;
    status: SetlistStatus;
    pins: PinState;
    // The frozen order + date once performed. In the schema this is the setlist_item
    // positions of a status='performed' set plus the performance date; the mock does
    // not persist items continuously, so it captures the order at perform time. null
    // until performed.
    performed: {
        songIds: string[];
        date: string;
        transitions: Record<string, number>;
        breaks: SetBreak[];
        // Frozen song metadata + event name/padding, captured at perform time so a performed set's sheet
        // and totals never shift when a song or event is edited later. Absent on sets performed before
        // this existed (the sl-winter seed, or prod rows from before the snapshot column existed): read live as a fallback.
        snapshot?: {
            songs: SongRow[];
            eventName: string;
            padding: { perSongSeconds: number; perSetSeconds: number };
        };
    } | null;
    // The order frozen when the director PUBLISHES the set to members. A draft has no
    // persisted order, so publish captures the current re-drafted order and freezes it here; the
    // member call sheet reads this, not a live re-draft, so the published set does not shift under
    // them. Separate from `performed` so publishing never blocks the director from editing the
    // draft. `at` is the publish time (also the member-visibility gate). null = unpublished.
    // The schema mirror is setlist.published_at + setlist.published_order (jsonb).
    published: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
        at: string;
    } | null;
    // Whether the director is sharing the live draft with members (distinct from publish, which
    // freezes). Schema mirror: setlist.share_draft. draftOrder is the current order snapshot the
    // member preview reads, kept fresh by the director's edits (auto-resynced). Schema mirror:
    // setlist.draft_order (jsonb). null when never shared; carries the last snapshot while sharing.
    shareDraft: boolean;
    draftOrder: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
    } | null;
    // Per-song director annotations (transition / staging notes), keyed by songId. The
    // mock's projection of setlist_item.note; the mock does not persist item rows, so a
    // note sticks to its (setlist, song) pair across re-drafts.
    notes: Record<string, string>;
    // Per-song segue overrides (the gap LEAVING a song), keyed by songId. The mock's
    // projection of setlist_item.transition_seconds; sticks across re-drafts like notes.
    transitions: Record<string, number>;
    // Breaks (intermissions) at ordinal slots. The mock's projection of setlist_break;
    // ordinal (afterPosition), so they survive a re-draft that changes which songs fill.
    breaks: SetBreak[];
    // The director's manual running order (drag / Auto-arrange), a list of song ids. loadSetlist
    // applies it (reconciled to the drafted set) so the director's view, publish, and share all honor
    // it; a redraft (pin change / Re-generate) clears it. Schema mirror: setlist.arranged_order (jsonb).
    arrangedOrder?: string[] | null;
}

// ---------------------------------------------------------------------------
// The store. Mutable module state.
// ---------------------------------------------------------------------------

// The ensemble's tag vocabulary. Tenant-defined and editable (add, rename,
// recategorize, reorder, delete). category is one of the fixed schema enum
// values (or null). tagByName resolves a seed/posted name to its row.
const tags: TagRow[] = [
    { id: "tag-gospel", name: "gospel", category: "genre", sortOrder: 0 },
    { id: "tag-soul", name: "soul", category: "genre", sortOrder: 1 },
    { id: "tag-pop", name: "pop", category: "genre", sortOrder: 2 },
    { id: "tag-funk", name: "funk", category: "groove", sortOrder: 3 },
    { id: "tag-uptempo", name: "uptempo", category: "groove", sortOrder: 4 },
    { id: "tag-ballad", name: "ballad", category: "mood", sortOrder: 5 },
    {
        id: "tag-spiritual",
        name: "spiritual",
        category: "occasion",
        sortOrder: 6,
    },
];
const tagByName = (name: string): TagRow | undefined =>
    tags.find((t) => t.name === name);

// The ensemble's section vocabulary, seeded with a standard SATB + vocal
// percussion. sortOrder is the display order; nominal ranges are advisory.
const voiceParts: VoicePartRow[] = [
    {
        id: "vp-sop",
        label: "Soprano",
        sortOrder: 0,
        isPitched: true,
        nominalLowMidi: midi("C4"),
        nominalHighMidi: midi("A5"),
    },
    {
        id: "vp-alt",
        label: "Alto",
        sortOrder: 1,
        isPitched: true,
        nominalLowMidi: midi("G3"),
        nominalHighMidi: midi("D5"),
    },
    {
        id: "vp-ten",
        label: "Tenor",
        sortOrder: 2,
        isPitched: true,
        nominalLowMidi: midi("C3"),
        nominalHighMidi: midi("A4"),
    },
    {
        id: "vp-bas",
        label: "Bass",
        sortOrder: 3,
        isPitched: true,
        nominalLowMidi: midi("E2"),
        nominalHighMidi: midi("C4"),
    },
    {
        id: "vp-vp",
        label: "Vocal Percussion",
        sortOrder: 4,
        isPitched: false,
        nominalLowMidi: null,
        nominalHighMidi: null,
    },
];

const members: MemberRow[] = [
    {
        id: "m1",
        publicId: "m1",
        displayName: "Ana",
        role: "director",
        status: "active",
        singing: true,
        sections: [{ voicePartId: "vp-sop", isPrimary: true }],
        rangeLowMidi: midi("G3"),
        rangeHighMidi: midi("C6"),
        claimed: true,
        inviteEmail: null,
        invitedAt: null,
    },
    {
        id: "m2",
        publicId: "m2",
        displayName: "Ben",
        role: "member",
        status: "active",
        singing: true,
        sections: [{ voicePartId: "vp-ten", isPrimary: true }],
        rangeLowMidi: midi("C3"),
        rangeHighMidi: midi("A4"),
        claimed: true,
        inviteEmail: null,
        invitedAt: null,
    },
    // Cleo + Dane demo the pending-invite state (display-only in mock mode).
    {
        id: "m3",
        publicId: "m3",
        displayName: "Cleo",
        role: "member",
        status: "active",
        singing: true,
        sections: [
            { voicePartId: "vp-alt", isPrimary: true },
            { voicePartId: "vp-sop", isPrimary: false },
        ],
        rangeLowMidi: midi("F3"),
        rangeHighMidi: midi("E5"),
        claimed: false,
        inviteEmail: "cleo@example.com",
        invitedAt: "2026-06-27T00:00:00.000Z",
    },
    {
        id: "m4",
        publicId: "m4",
        displayName: "Dane",
        role: "member",
        status: "active",
        singing: true,
        sections: [{ voicePartId: "vp-bas", isPrimary: true }],
        rangeLowMidi: midi("E2"),
        rangeHighMidi: midi("D4"),
        claimed: false,
        inviteEmail: "dane@example.com",
        invitedAt: "2026-06-27T00:00:00.000Z",
    },
    // Fiona + Gus give the casting suggestions cross-section overlap to explore: Fiona
    // is an alto whose top reaches into the soprano line, Gus a high baritone who
    // covers the tenor line. So a soprano/tenor part shows them under "Also consider".
    {
        id: "m5",
        publicId: "m5",
        displayName: "Fiona",
        role: "member",
        status: "active",
        singing: true,
        sections: [{ voicePartId: "vp-alt", isPrimary: true }],
        rangeLowMidi: midi("A3"),
        rangeHighMidi: midi("A5"),
        claimed: false,
        inviteEmail: null,
        invitedAt: null,
    },
    {
        id: "m6",
        publicId: "m6",
        displayName: "Gus",
        role: "member",
        status: "active",
        singing: true,
        sections: [{ voicePartId: "vp-bas", isPrimary: true }],
        rangeLowMidi: midi("A2"),
        rangeHighMidi: midi("A4"),
        claimed: false,
        inviteEmail: null,
        invitedAt: null,
    },
];

const songs: SongRow[] = [];
const parts: MockPart[] = [];
const castings: MockCasting[] = [];

// Optimistic-concurrency versions, keyed by entity id (event / song / setlist). A
// monotonic counter rendered as an opaque string token: getEvent/getSong/getSetlistMeta
// attach the current value, and the guarded "replace the whole collection" writes check
// the caller's expected token before mutating, then bump it. The mock is single-threaded
// so a real race never occurs, but honoring the token keeps the contract identical to the
// supabase adapter (where the token is the row's updated_at). An id with no entry reads as
// '0' (seeded entities never having been written through a guarded path yet).
const versions = new Map<string, number>();
const ver = (id: string): string => String(versions.get(id) ?? 0);
const bumpVersion = (id: string): string => {
    const next = (versions.get(id) ?? 0) + 1;
    versions.set(id, next);
    return String(next);
};

// --- Ensemble settings (schema: the ensemble row's editable fields) -----------------
export type ConfidenceVisibility = "private" | "shared";
export interface EnsembleSettings {
    name: string;
    timezone: string; // IANA; anchors date math
    confidenceVisibility: ConfidenceVisibility;
    version?: string; // optimistic-concurrency token (getEnsembleSettings only)
}
export interface EnsembleSettingsInput {
    name: string;
    timezone: string;
    confidenceVisibility: ConfidenceVisibility;
}
// The outcome of a guarded settings write: ok with the new token, a conflict (the loaded token is
// stale — another director saved since), or forbidden (a non-director; only the Supabase path,
// where RLS denies the write, ever raises this).
export type EnsembleSettingsResult =
    | { ok: true; version: string }
    | { ok: false; reason: "conflict" | "forbidden" };

// The mock stands in for one ensemble; this is its editable settings row, seeded to
// mirror "Harmony Collective". A director edits it; the Supabase path writes the real
// ensemble row under the director-only ensemble_update policy. Its version is a counter
// (the supabase token is ensemble.updated_at), so concurrent saves can detect a stale write.
const ENSEMBLE_SETTINGS_VERSION_KEY = "ensemble-settings";
const ensembleSettings: EnsembleSettingsInput = {
    name: "Harmony Collective",
    timezone: "America/New_York",
    confidenceVisibility: "private",
};
export function getEnsembleSettings(): EnsembleSettings {
    return { ...ensembleSettings, version: ver(ENSEMBLE_SETTINGS_VERSION_KEY) };
}
export function updateEnsembleSettings(
    input: EnsembleSettingsInput,
    expectedVersion: string,
): EnsembleSettingsResult {
    if (expectedVersion !== ver(ENSEMBLE_SETTINGS_VERSION_KEY))
        return { ok: false, reason: "conflict" };
    ensembleSettings.name = input.name;
    ensembleSettings.timezone = input.timezone;
    ensembleSettings.confidenceVisibility = input.confidenceVisibility;
    return { ok: true, version: bumpVersion(ENSEMBLE_SETTINGS_VERSION_KEY) };
}

// "Today" (YYYY-MM-DD) in the ensemble's timezone — the day boundary the SQL anchors to
// (current_date at the ensemble tz), so the mock's date fallbacks match Supabase instead
// of drifting a day at midnight. en-CA formats as ISO YYYY-MM-DD.
function todayInEnsembleTz(): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: ensembleSettings.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

// Seed helper: register a song plus its parts and the single cover on each. The
// first part is the featured lead (isPrimary).
interface SeedPart {
    label: string;
    member: string;
    confidence?: Confidence;
    required?: boolean;
    count?: number;
}
function seed(
    id: string,
    title: string,
    attrs: {
        start: KeySig | null;
        end?: KeySig | null;
        tempo: number | null;
        endTempo?: number | null;
        dur: number | null;
        intensity: number | null;
        tags: string[];
        readiness?: Song["assessedReadiness"];
        book?: Song["bookStatus"];
        explicit?: boolean;
        accompaniment?: boolean;
    },
    seedParts: SeedPart[],
): void {
    songs.push({
        id,
        publicId: id,
        title,
        startKey: attrs.start,
        endKey: attrs.end ?? null,
        startTempoBpm: attrs.tempo,
        endTempoBpm: attrs.endTempo ?? null,
        durationSeconds: attrs.dur,
        isExplicit: attrs.explicit ?? false,
        usesAccompaniment: attrs.accompaniment ?? false,
        intensity: attrs.intensity,
        tags: attrs.tags.map((name) => ({
            name,
            category: tagByName(name)?.category ?? null,
        })),
        assessedReadiness: attrs.readiness ?? "performance-ready",
        bookStatus: attrs.book ?? "off-book",
        lastPerformed: null,
        status: "active",
        arranger: null,
        chartRef: null,
        lastRehearsed: null,
        startPitch: null,
    });
    seedParts.forEach((sp, i) => {
        const partId = `${id}-p${i + 1}`;
        // A label that names a section (Bass, Soprano) is that section; anything else
        // (Lead) is a solo. Keeps the seed consistent with the solo/section rule.
        const section = voiceParts.find((v) => v.label === sp.label);
        const isSolo = !section;
        parts.push({
            id: partId,
            songId: id,
            isRequired: sp.required ?? true,
            countNeeded: sp.count ?? 1,
            label: sp.label,
            voicePartId: section ? section.id : null,
            isSolo,
            rangeLowMidi: null,
            rangeHighMidi: null,
            sortOrder: i,
        });
        castings.push({
            partId,
            memberId: sp.member,
            isPrimary: i === 0,
            confidence: sp.confidence ?? "solid",
            directorAssessed: null,
            learnedAt: null,
        });
    });
}

const M = ({
    fifths,
    mode,
}: {
    fifths: number;
    mode: "major" | "minor";
}): KeySig => ({ fifths, mode });

// A shared repertoire. Casting spreads across the four members, so an event with
// some members out leaves songs uncoverable (and, when the missing singer is only
// tentative, chaseable).
seed(
    "wade",
    "Wade in the Water",
    {
        start: M({ fifths: 0, mode: "major" }),
        tempo: 96,
        dur: 240,
        intensity: 3,
        tags: ["gospel", "spiritual"],
    },
    [
        { label: "Lead", member: "m1" },
        { label: "Bass", member: "m3" },
    ],
);
seed(
    "happy",
    "Oh Happy Day",
    {
        start: M({ fifths: 1, mode: "major" }),
        end: M({ fifths: 3, mode: "major" }),
        tempo: 120,
        dur: 250,
        intensity: 4,
        tags: ["gospel"],
        readiness: "needs-polish",
    },
    [
        { label: "Lead", member: "m2" },
        { label: "Bass", member: "m4" },
    ],
);
seed(
    "grave",
    "Ain't No Grave",
    {
        start: M({ fifths: 2, mode: "major" }),
        tempo: 132,
        endTempo: 144,
        dur: 230,
        intensity: 5,
        tags: ["gospel", "uptempo"],
    },
    [
        { label: "Lead", member: "m3", confidence: "shaky" },
        { label: "Bass", member: "m1" },
    ],
);
seed(
    "bridge",
    "Bridge Over Troubled Water",
    {
        start: M({ fifths: 0, mode: "minor" }),
        tempo: 68,
        dur: 255,
        intensity: 2,
        tags: ["ballad"],
        book: "on-book",
    },
    [
        { label: "Lead", member: "m4" },
        { label: "Bass", member: "m2" },
    ],
);
seed(
    "lean",
    "Lean on Me",
    {
        start: M({ fifths: -1, mode: "major" }),
        tempo: 88,
        dur: 235,
        intensity: 3,
        tags: ["soul"],
    },
    [
        { label: "Lead", member: "m1" },
        { label: "Bass", member: "m2" },
    ],
);
seed(
    "mountain",
    "Ain't No Mountain High Enough",
    {
        start: M({ fifths: -2, mode: "major" }),
        tempo: 124,
        dur: 245,
        intensity: 4,
        tags: ["soul", "uptempo"],
        accompaniment: true,
    },
    [
        { label: "Lead", member: "m2" },
        { label: "Bass", member: "m3" },
    ],
);
seed(
    "river",
    "Down to the River to Pray",
    {
        start: M({ fifths: 1, mode: "major" }),
        tempo: 80,
        dur: 215,
        intensity: 2,
        tags: ["gospel", "spiritual"],
    },
    [
        { label: "Lead", member: "m3" },
        { label: "Bass", member: "m4" },
    ],
);
seed(
    "shout",
    "Shout",
    {
        start: M({ fifths: 4, mode: "major" }),
        tempo: 140,
        dur: 210,
        intensity: 5,
        tags: ["uptempo"],
        readiness: "needs-polish",
    },
    [
        { label: "Lead", member: "m4" },
        { label: "Bass", member: "m1" },
    ],
);
seed(
    "stand",
    "Stand By Me",
    {
        start: M({ fifths: 0, mode: "major" }),
        tempo: 100,
        dur: 240,
        intensity: 3,
        tags: ["soul"],
    },
    [
        { label: "Lead", member: "m1" },
        { label: "Bass", member: "m2" },
    ],
);
seed(
    "higher",
    "Higher Ground",
    {
        start: M({ fifths: 2, mode: "major" }),
        tempo: 128,
        dur: 260,
        intensity: 5,
        tags: ["funk"],
    },
    [
        { label: "Lead", member: "m1" },
        { label: "Soprano", member: "m3" },
    ],
);
seed(
    "old",
    "Old Spiritual",
    {
        start: M({ fifths: -1, mode: "major" }),
        tempo: 76,
        dur: 200,
        intensity: 2,
        tags: ["ballad"],
        readiness: "dormant",
    },
    [
        { label: "Lead", member: "m1" },
        { label: "Bass", member: "m2" },
    ],
);
// A full SATB chart, so every section line has a casting-suggestion panel to explore:
// primary (section-eligible) plus the cross-section "Also consider" tier. Each section
// is cast to one member, leaving the rest as candidates.
seed(
    "amazing",
    "Amazing Grace",
    {
        start: M({ fifths: 1, mode: "major" }),
        tempo: 72,
        dur: 220,
        intensity: 2,
        tags: ["spiritual", "ballad"],
    },
    [
        { label: "Lead", member: "m3" },
        { label: "Soprano", member: "m1" },
        { label: "Alto", member: "m5" },
        { label: "Tenor", member: "m2" },
        { label: "Bass", member: "m4" },
    ],
);

// Two songs the group is still learning, with the director's read of each cover, so
// the learning tracker has content (grave: Cleo's lead still learning, Ana's bass
// solid; bridge: Dane's lead shaky, Ben's bass not yet assessed).
for (const sid of ["grave", "bridge"]) {
    const s = songs.find((x) => x.id === sid);
    if (s) s.assessedReadiness = "learning";
}
const seedAssess = (
    partId: string,
    memberId: string,
    v: Confidence | null,
    learnedAt: string | null = null,
) => {
    const c = castings.find(
        (x) => x.partId === partId && x.memberId === memberId,
    );
    if (c) {
        c.directorAssessed = v;
        c.learnedAt = learnedAt;
    }
};
seedAssess("grave-p1", "m3", "learning");
seedAssess("grave-p2", "m1", "solid", "2026-05-01");
seedAssess("bridge-p1", "m4", "shaky");

// Lead solos name their own range (a solo has no section to fall back to), so the
// casting screen can rank soloists against it. Section lines use their section nominal.
const soloRanges: Record<string, [string, string]> = {
    "grave-p1": ["G3", "G4"],
    "amazing-p1": ["G3", "B4"],
};
for (const [partId, [lo, hi]] of Object.entries(soloRanges)) {
    const p = parts.find((x) => x.id === partId);
    if (p) {
        p.rangeLowMidi = midi(lo);
        p.rangeHighMidi = midi(hi);
    }
}

// The system default set padding. Shared with the event coercer so a form that
// omits the padding fields lands on the same defaults the seeds use, not zero.
export const DEFAULT_PADDING = { perSongSeconds: 30, perSetSeconds: 60 };
const padding = DEFAULT_PADDING;

// Reusable padding presets and event types (schema: padding_profile, event_type).
// Create-time templates: an event snapshots a type's resolved values at create.
const paddingProfiles: PaddingProfileRow[] = [
    {
        id: "pp-concert",
        name: "Concert",
        perSongSeconds: 30,
        perSetSeconds: 90,
    },
    {
        id: "pp-service",
        name: "Church service",
        perSongSeconds: 20,
        perSetSeconds: 180,
    },
];
const eventTypes: EventTypeRow[] = [
    {
        id: "et-concert",
        name: "Concert",
        sortOrder: 0,
        paddingProfileId: "pp-concert",
        defaultAllowsOnBook: true,
        defaultAllowsExplicit: false,
        defaultAllowsAccompaniment: true,
        excludeTags: [],
        preferTags: ["uptempo"],
        requireTags: [],
    },
    {
        id: "et-service",
        name: "Church service",
        sortOrder: 1,
        paddingProfileId: "pp-service",
        defaultAllowsOnBook: true,
        defaultAllowsExplicit: false,
        defaultAllowsAccompaniment: true,
        excludeTags: [],
        preferTags: ["spiritual"],
        requireTags: [],
    },
];

// Mock event dates are anchored to today, computed once at module load, so the demo always has a
// realistic past/future spread. Several features gate on "future" (the rehearsal picker's
// upcoming-gig facet, the dashboard's next-gig hero) or "gone cold" (staleness); hardcoded dates
// silently drop out of those windows as the calendar advances. Offsets in days preserve the seed's
// ordering: winter is a long-past performed gig, the summer concert recently past, the rehearsal the
// soonest upcoming event, and the church service the next gig (after the rehearsal, so the
// fail-closed hero still shows the gig, not the sooner rehearsal).
const MS_PER_DAY = 86_400_000;
const seededDate = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);

const events: EventRow[] = [
    {
        id: "concert",
        publicId: "concert",
        eventTypeId: "et-concert",
        name: "Summer concert",
        venue: "Memorial Hall",
        status: "planned",
        kind: "gig",
        resolved: {
            id: "concert",
            eventDate: seededDate(-19),
            targetDurationSeconds: 1140,
            maxDurationSeconds: 1200,
            allowsOnBook: true,
            allowsExplicit: false,
            allowsAccompaniment: false,
            padding,
        },
        availability: members.map(
            (m): Availability => ({ memberId: m.id, status: "in" }),
        ),
        excludeTags: [],
        preferTags: [],
        // Demo: the concert mandates at least one gospel number (required-material rule).
        requireTags: ["gospel"],
    },
    {
        id: "church",
        publicId: "church",
        eventTypeId: "et-service",
        name: "Church service",
        venue: "First Methodist",
        status: "planned",
        kind: "gig",
        resolved: {
            id: "church",
            eventDate: seededDate(8),
            targetDurationSeconds: 1200,
            maxDurationSeconds: null,
            allowsOnBook: true,
            allowsExplicit: false,
            allowsAccompaniment: true,
            padding,
        },
        // Cleo is tentative (chaseable), Dane is out (a hard no), so much of the
        // repertoire is uncoverable: a thin set, a shortfall, and a rich chase lever.
        availability: [
            { memberId: "m1", status: "in" },
            { memberId: "m2", status: "in" },
            { memberId: "m3", status: "tentative" },
            { memberId: "m4", status: "out" },
        ],
        excludeTags: [],
        preferTags: [],
        requireTags: [],
    },
    {
        id: "winter",
        publicId: "winter",
        eventTypeId: null,
        name: "Winter showcase",
        venue: "Old Chapel",
        status: "planned",
        kind: "gig",
        resolved: {
            id: "winter",
            eventDate: seededDate(-150),
            targetDurationSeconds: 1080,
            maxDurationSeconds: null,
            allowsOnBook: true,
            allowsExplicit: false,
            allowsAccompaniment: true,
            padding,
        },
        availability: members.map(
            (m): Availability => ({ memberId: m.id, status: "in" }),
        ),
        excludeTags: [],
        preferTags: [],
        requireTags: [],
    },
    {
        // A rehearsal event, so the Rehearsals tab and member RSVP
        // have content. No setlist (rehearsals get an agenda instead). A couple of non-'in'
        // RSVPs demo the grid; dated BEFORE the next gig (the church service, three days later) on
        // purpose, to prove the fail-closed listEvents default keeps it off the dashboard hero even
        // when it is chronologically the soonest upcoming event.
        id: "reh1",
        publicId: "reh1",
        eventTypeId: null,
        name: "Sunday rehearsal",
        venue: "Rehearsal room",
        status: "planned",
        kind: "rehearsal",
        resolved: {
            id: "reh1",
            eventDate: seededDate(5),
            targetDurationSeconds: 5400,
            maxDurationSeconds: null,
            allowsOnBook: true,
            allowsExplicit: false,
            allowsAccompaniment: true,
            padding,
        },
        availability: [
            { memberId: "m1", status: "in" },
            { memberId: "m2", status: "in" },
            { memberId: "m3", status: "tentative" },
            { memberId: "m4", status: "in" },
            { memberId: "m5", status: "in" },
            { memberId: "m6", status: "out" },
        ],
        excludeTags: [],
        preferTags: [],
        requireTags: [],
    },
];

// The per-rehearsal agenda. One ordered list of items per
// rehearsal event; position is array order. reason records why an item was added
// (a suggestion's top reason kind, or null for a director's own pick). The mock's
// projection of the rehearsal_item table. Seeded partial on reh1, so the saved list
// and the remaining suggestions both show live.
export interface RehearsalAgendaItem {
    songId: string;
    reason: string | null;
    note: string | null;
}
const rehearsalAgendas = new Map<string, RehearsalAgendaItem[]>([
    [
        "reh1",
        [
            {
                songId: "grave",
                reason: "coverage-risk",
                note: "Run the bass entrance twice, m3 still shaky on the lead.",
            },
            { songId: "happy", reason: "learning-gap", note: null },
        ],
    ],
]);

// Prep targets. Songs a gig wants ready by its date (an explicit
// "learn X for gig Y" commitment). One unordered set per gig; the mock's projection of the
// prep_target table. Seeded on the upcoming church service, mixing ready and not-ready songs
// so the "behind schedule" view has something to show.
const prepTargets = new Map<string, string[]>([
    ["church", ["happy", "old", "amazing", "river", "wade"]],
]);

const setlists = new Map<string, SetlistRow>([
    [
        "sl-concert",
        {
            eventId: "concert",
            programId: null,
            name: "Main set",
            status: "draft",
            pins: { ...EMPTY_PINS },
            performed: null,
            published: null,
            shareDraft: false,
            draftOrder: null,
            notes: { higher: "Watch the key change into the bridge" },
            transitions: { river: 0 },
            breaks: [],
        },
    ],
    // Shared with members as a live draft (share_draft on), so the member draft preview has something
    // to show out of the box. draftOrder is the snapshot members read; the director's edits refresh it.
    [
        "sl-church",
        {
            eventId: "church",
            programId: null,
            name: "Service set",
            status: "draft",
            pins: { ...EMPTY_PINS },
            performed: null,
            published: null,
            shareDraft: true,
            draftOrder: {
                songIds: ["happy", "amazing", "wade", "river"],
                transitions: {},
                breaks: [],
            },
            notes: {},
            transitions: {},
            breaks: [],
        },
    ],
    // A past performed set, so history and the recency penalty have something to show.
    [
        "sl-winter",
        {
            eventId: "winter",
            programId: null,
            name: "Winter set",
            status: "performed",
            pins: { ...EMPTY_PINS },
            performed: {
                songIds: ["lean", "stand", "bridge", "wade"],
                date: seededDate(-150),
                transitions: { stand: 0 },
                breaks: [
                    {
                        id: "brk-winter",
                        label: "Intermission",
                        durationSeconds: 600,
                        afterPosition: 2,
                    },
                ],
            },
            published: null,
            shareDraft: false,
            draftOrder: null,
            notes: { bridge: "Soft open, let the room settle" },
            transitions: { stand: 0 },
            breaks: [
                {
                    id: "brk-winter",
                    label: "Intermission",
                    durationSeconds: 600,
                    afterPosition: 2,
                },
            ],
        },
    ],
]);

// Reflect the seeded performed set: its songs carry their last-performed date, so a
// draft near it spreads the repetition (the drafter's recency penalty). They were also
// last rehearsed for that winter show and not since, so months later they read as
// "gone cold" (not rehearsed in 90+ days) and surface in the not-in-the-set view.
for (const sid of ["lean", "stand", "bridge", "wade"]) {
    const s = songs.find((x) => x.id === sid);
    if (s) {
        s.lastPerformed = seededDate(-150);
        s.lastRehearsed = seededDate(-154);
    }
}

// Who actually soloed at each performance, snapshotted at perform time (schema:
// performance_soloist) so equity stays true even if the casting changes afterwards.
// The display fields are denormalized (frozen at snapshot), so the record survives
// later deletion of the part, song, or member — mirroring the performance_soloist snapshot columns in the database.
interface SoloistRecord {
    setlistId: string;
    songId: string;
    partId: string;
    memberId: string;
    songTitle: string;
    partLabel: string;
    displayName: string;
}
const performanceSoloists: SoloistRecord[] = [];

// Record the featured lead on each solo part of the songs that ran, freezing the
// title/label/name as they are now.
function snapshotSoloists(setlistId: string, songIds: string[]): void {
    for (const songId of songIds) {
        for (const part of parts) {
            if (part.songId !== songId || !part.isSolo) continue;
            const lead = castings.find(
                (c) => c.partId === part.id && c.isPrimary,
            );
            if (!lead) continue;
            performanceSoloists.push({
                setlistId,
                songId,
                partId: part.id,
                memberId: lead.memberId,
                songTitle: songs.find((s) => s.id === songId)?.title ?? songId,
                partLabel: part.label ?? "Solo",
                displayName:
                    members.find((m) => m.id === lead.memberId)?.displayName ??
                    lead.memberId,
            });
        }
    }
}

// Seed the soloists for the past performed set, so soloist equity has history.
snapshotSoloists("sl-winter", ["lean", "stand", "bridge", "wade"]);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Project mock rows down to the drafter's core shapes (drop the admin/section
// fields the drafter does not read).
const stripStatus = (row: SongRow): Song => {
    // publicId is a routing field, not a domain one: strip it here so it never enters core's Song.
    const {
        status: _s,
        arranger: _a,
        chartRef: _c,
        startPitch: _sp,
        publicId: _pid,
        ...song
    } = row;
    return song;
};
const stripPart = (p: MockPart): Part => {
    const {
        voicePartId: _vp,
        isSolo: _is,
        rangeLowMidi: _rl,
        rangeHighMidi: _rh,
        sortOrder: _so,
        ...part
    } = p;
    return part;
};
const stripCasting = (c: MockCasting): Casting => {
    const { learnedAt: _la, ...casting } = c;
    return casting;
};

/** Project the draft input for an event, active songs only. Mirrors hydrate_draft_input. */
export function hydratePayload(eventId: string): HydrationPayload | null {
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return null;
    const active = songs.filter((s) => s.status === "active");
    const activeIds = new Set(active.map((s) => s.id));
    const activeParts = parts.filter((p) => activeIds.has(p.songId));
    const activePartIds = new Set(activeParts.map((p) => p.id));
    // Active, singing roster only, projected to the drafter's Member shape;
    // availability is scoped to them so an archived or non-singing member never
    // counts toward coverage.
    const singers = members.filter((m) => m.status === "active" && m.singing);
    const memberIds = new Set(singers.map((m) => m.id));
    return {
        event: ev.resolved,
        members: singers.map((m) => ({ id: m.id, displayName: m.displayName })),
        availability: ev.availability.filter((a) => memberIds.has(a.memberId)),
        songs: active.map(stripStatus),
        parts: activeParts.map(stripPart),
        castings: castings
            .filter((c) => activePartIds.has(c.partId))
            .map(stripCasting),
        excludeTags: ev.excludeTags,
        preferTags: ev.preferTags,
        requireTags: ev.requireTags,
    };
}

export function getLocks(setlistId: string) {
    const rec = setlists.get(setlistId);
    // Mirror hydrate_setlist_locks.sql, which always builds the full document (every
    // list defaults to []) even for a missing/invisible setlist — so transitions: [] and
    // breaks: [] are present here too, not undefined, keeping the mock and SQL shapes identical.
    if (!rec)
        return {
            eventId: null,
            opens: [],
            closes: [],
            keep: [],
            excluded: [],
            transitions: [],
            breaks: [],
        };
    const p = rec.pins;
    return {
        eventId: rec.eventId,
        opens: p.open ? [p.open] : [],
        closes: p.close ? [p.close] : [],
        keep: p.keep,
        excluded: p.excluded,
        transitions: Object.entries(rec.transitions).map(
            ([songId, seconds]) => ({ songId, seconds }),
        ),
        breaks: rec.breaks.map((b) => ({ ...b })),
    };
}

export function setPins(setlistId: string, pins: PinState): void {
    const rec = setlists.get(setlistId);
    if (rec) rec.pins = pins;
}

export function markPerformed(setlistId: string, order?: string[]): boolean {
    const rec = setlists.get(setlistId);
    if (!rec) return false;
    // The mock records a performed set only WITH a frozen order (it does not persist
    // setlist_item to stamp from). Without one this reports existence and changes
    // nothing, so status='performed' and a frozen record can never diverge; the
    // Supabase path stamps last_performed from setlist_item in SQL.
    if (!order) return true;
    // A performed set is an immutable record: never overwrite a frozen order.
    if (rec.performed) return false;
    const event = events.find((e) => e.id === rec.eventId);
    // The performance date is the event's, or today in the ensemble's timezone (matching the
    // SQL's current_date-at-ensemble-tz, so the mock and Supabase agree on the day boundary).
    const date = event?.resolved.eventDate ?? todayInEnsembleTz();
    rec.status = "performed";
    // Freeze the segues with the order, so a performed sheet keeps its attaccas —
    // scoped to the songs that ran, so a stale override on a since-excluded song
    // never leaks into the frozen record.
    const frozenTransitions: Record<string, number> = {};
    for (const id of order) {
        if (rec.transitions[id] !== undefined)
            frozenTransitions[id] = rec.transitions[id];
    }
    // Freeze the breaks the same way core places them at draft time (clamp into
    // [1, order.length-1] + dedupe), so a trailing/out-of-range break is clamped in like the
    // Supabase render would, not silently dropped from the frozen record.
    const frozenBreaks = normalizeBreaks(rec.breaks, order.length);
    // Snapshot the song metadata + event name/padding NOW, so the performed sheet and totals stay
    // frozen when a song or the event is edited later (matching the Supabase performed_snapshot).
    const snapSongs = order
        .map((id) => songs.find((s) => s.id === id))
        .filter((s): s is SongRow => s !== undefined)
        .map((s) => ({ ...s }));
    rec.performed = {
        songIds: [...order],
        date,
        transitions: frozenTransitions,
        breaks: frozenBreaks,
        snapshot: {
            songs: snapSongs,
            eventName: event?.name ?? "Event",
            padding: event
                ? {
                      perSongSeconds: event.resolved.padding.perSongSeconds,
                      perSetSeconds: event.resolved.padding.perSetSeconds,
                  }
                : { ...DEFAULT_PADDING },
        },
    };
    // Snapshot who actually soloed, taken now so it survives later casting changes.
    snapshotSoloists(setlistId, order);
    // Stamp last_performed = greatest(current, date) for the songs that ran, mirroring
    // the perform_setlist RPC, so the next draft spreads repetition.
    for (const sid of order) {
        const song = songs.find((s) => s.id === sid);
        if (song && (song.lastPerformed === null || date > song.lastPerformed))
            song.lastPerformed = date;
    }
    return true;
}

// Set or clear a per-song note on a setlist. An empty note removes the entry.
export function setItemNote(
    setlistId: string,
    songId: string,
    note: string,
): boolean {
    const rec = setlists.get(setlistId);
    if (!rec) return false;
    if (note) rec.notes[songId] = note;
    else delete rec.notes[songId];
    return true;
}

// The notes for a setlist, scoped to the songs currently in it.
export function getItemNotes(
    setlistId: string,
    songIds: string[],
): Record<string, string> {
    const rec = setlists.get(setlistId);
    if (!rec) return {};
    const out: Record<string, string> = {};
    for (const id of songIds) {
        const n = rec.notes[id];
        if (n) out[id] = n;
    }
    return out;
}

// Set or clear a per-song segue override (the gap LEAVING a song, in seconds; 0 =
// attacca). null removes it, falling back to the event's per-song padding.
export function setTransition(
    setlistId: string,
    songId: string,
    seconds: number | null,
): boolean {
    const rec = setlists.get(setlistId);
    if (!rec) return false;
    if (seconds === null) delete rec.transitions[songId];
    else rec.transitions[songId] = seconds;
    return true;
}

// The segue overrides for a setlist, scoped to the songs currently in it.
export function getTransitions(
    setlistId: string,
    songIds: string[],
): Record<string, number> {
    const rec = setlists.get(setlistId);
    if (!rec) return {};
    const out: Record<string, number> = {};
    for (const id of songIds) {
        const t = rec.transitions[id];
        if (t !== undefined) out[id] = t;
    }
    return out;
}

// Replace this setlist's breaks (intermissions). The caller's coercer validates the
// fields and enforces one break per ordinal slot; the mock just stores the list.
export function setBreaks(
    setlistId: string,
    breaks: SetBreak[],
    expectedVersion: string,
): WriteResult {
    const rec = setlists.get(setlistId);
    if (!rec) return { ok: false, reason: "not_found" };
    if (ver(setlistId) !== expectedVersion)
        return { ok: false, reason: "conflict" };
    rec.breaks = breaks.map((b) => ({ ...b }));
    return { ok: true, version: bumpVersion(setlistId) };
}

// This setlist's breaks, ordered by their ordinal slot. Used by getLocks and the payload.
export function getBreaks(setlistId: string): SetBreak[] {
    const rec = setlists.get(setlistId);
    if (!rec) return [];
    return rec.breaks
        .map((b) => ({ ...b }))
        .sort((a, b) => a.afterPosition - b.afterPosition);
}

export interface SoloistAppearance {
    memberId: string;
    displayName: string; // resolved from the full roster, so a departed soloist keeps a name
    songTitle: string;
    eventName: string;
    date: string;
}

// Every solo actually performed, across performed sets, for soloist equity. The song
// title and soloist name come from the frozen snapshot, so a part/song/member deleted
// after the performance never erases or rewrites the historical record.
export function listSoloistAppearances(): SoloistAppearance[] {
    const out: SoloistAppearance[] = [];
    for (const r of performanceSoloists) {
        const setlist = setlists.get(r.setlistId);
        if (!setlist || setlist.status !== "performed" || !setlist.performed)
            continue;
        const event = events.find((e) => e.id === setlist.eventId);
        out.push({
            memberId: r.memberId,
            displayName: r.displayName,
            songTitle: r.songTitle,
            eventName: event?.name ?? "Event",
            date: setlist.performed.date,
        });
    }
    return out;
}

// --- Setlists (name, status, multiple per event) --------------------------

export interface SetlistMeta {
    id: string;
    // The URL token for this setlist (the print sheet, deep links). Never replaces id (the uuid).
    publicId: string;
    eventId: string;
    name: string | null;
    status: SetlistStatus;
    // When the director published this set to members, else null. The member
    // call sheet is visible when this is set OR the set is performed (a gig that happened is
    // always visible). Schema mirror: setlist.published_at.
    publishedAt: string | null;
    // Whether the director is sharing the live draft with members (setlist.share_draft), so the
    // editor can show the toggle state. Distinct from publishedAt: sharing is live and reversible.
    shareDraft: boolean;
    version?: string; // optimistic-concurrency token for breaks writes (getSetlistMeta only)
}

const setlistMeta = (id: string, r: SetlistRow): SetlistMeta => ({
    id,
    // The mock has no separate token, so the id doubles as the public_id. The Supabase adapter
    // projects the real setlist.public_id here.
    publicId: id,
    eventId: r.eventId,
    name: r.name,
    status: r.status,
    publishedAt: r.published?.at ?? null,
    shareDraft: r.shareDraft,
    version: ver(id),
});

export function listEventSetlists(eventId: string): SetlistMeta[] {
    return [...setlists.entries()]
        .filter(([, r]) => r.eventId === eventId)
        .map(([id, r]) => setlistMeta(id, r));
}

export function getSetlistMeta(setlistId: string): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    return r ? setlistMeta(setlistId, r) : undefined;
}

// The director's manual running order, or null when none is set (a fresh draft, or after a redraft
// cleared it). loadSetlist applies it over the drafter's order.
export function getArrangedOrder(setlistId: string): string[] | null {
    return setlists.get(setlistId)?.arrangedOrder ?? null;
}

// Persist (order) or clear (null) the manual order. Draft-only, like the other order writes. Bumps
// the version because the supabase adapter's setlist UPDATE fires moddatetime — the /order route
// returns the new version so the editor advances its break-edit token instead of false-conflicting.
export function setArrangedOrder(
    setlistId: string,
    order: string[] | null,
): void {
    const r = setlists.get(setlistId);
    if (!r || r.status !== "draft") return;
    r.arrangedOrder = order && order.length ? [...order] : null;
    bumpVersion(setlistId);
}

// Why a setlist rejects edits, or null when it is an editable draft. A performed set is
// an immutable record; a final set is locked until the director reverts it to draft. The
// mutating routes call this so the lock is enforced server-side, not just in the UI.
export function setlistLockReason(setlistId: string): string | null {
    const status = getSetlistMeta(setlistId)?.status;
    if (status === "performed") return "a performed set is read-only";
    if (status === "final")
        return "this set is finalized: revert it to draft to edit";
    return null;
}

export function createSetlist(
    eventId: string,
    name: string | null,
    programId: string | null = null,
): SetlistMeta | undefined {
    if (!events.some((e) => e.id === eventId)) return undefined;
    const id = newId("sl");
    const row: SetlistRow = {
        eventId,
        programId,
        name,
        status: "draft",
        pins: { ...EMPTY_PINS },
        performed: null,
        published: null,
        shareDraft: false,
        draftOrder: null,
        notes: {},
        transitions: {},
        breaks: [],
    };
    setlists.set(id, row);
    return setlistMeta(id, row);
}

export function updateSetlist(
    setlistId: string,
    patch: { name?: string | null; status?: SetlistStatus },
): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    if (!r) return undefined;
    // A performed set is an immutable record, and 'performed' is reached only by
    // performing (which freezes an order), never set here. Reject both so the status
    // flag and the frozen record can never diverge.
    if (r.status === "performed" || patch.status === "performed")
        return undefined;
    if (patch.name !== undefined) r.name = patch.name;
    if (patch.status !== undefined) r.status = patch.status;
    return setlistMeta(setlistId, r);
}

export type SetlistDeleteResult =
    | { ok: true }
    | { ok: false; reason: "not-found" | "performed" };

export function deleteSetlist(setlistId: string): SetlistDeleteResult {
    const rec = setlists.get(setlistId);
    if (!rec) return { ok: false, reason: "not-found" };
    // A performed set is an immutable record, like updateSetlist and markPerformed
    // enforce. Deleting one would erase frozen history and orphan its soloist rows.
    if (rec.status === "performed") return { ok: false, reason: "performed" };
    setlists.delete(setlistId);
    return { ok: true };
}

// Publish a set to members: store the given order as the member-visible frozen set, so
// the call sheet does not shift under a re-draft. A draft has no persisted order, so the caller
// (the publish route) re-drafts to capture the current order and freezes the segues + breaks to it
// the same way a performed set is frozen; this stores that snapshot verbatim, so the mock and the
// Supabase adapter persist an identical frozen set. Re-publishing overwrites. A performed set is
// already visible and immutable, so it is never published through here.
export function publishSetlist(
    setlistId: string,
    snapshot: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
    },
): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    if (!r || r.status === "performed") return undefined;
    r.published = {
        songIds: [...snapshot.songIds],
        transitions: { ...snapshot.transitions },
        breaks: snapshot.breaks.map((b) => ({ ...b })),
        at: new Date().toISOString(),
    };
    return setlistMeta(setlistId, r);
}

// Withdraw a set from members. Clears the published snapshot. A performed set stays visible on its
// own (its visibility is the performed status, not this flag), and under Supabase the
// performed-immutability trigger rejects touching the row, so unpublishing a performed set is a
// no-op in both adapters: leave it and return the meta unchanged.
export function unpublishSetlist(setlistId: string): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    if (!r) return undefined;
    if (r.status !== "performed") r.published = null;
    return setlistMeta(setlistId, r);
}

// Share the live draft with members: turn share_draft on and store the given order as the
// member-visible draft_order. Like publish, the caller (the share route) re-drafts to capture the
// current order; UNLIKE publish it is not frozen — the director's edits refresh it (see
// syncSharedDraftOrder), and it can be turned off. A performed set is already visible, never shared.
export function shareSetlistDraft(
    setlistId: string,
    snapshot: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
    },
): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    if (!r || r.status === "performed") return undefined;
    r.shareDraft = true;
    r.draftOrder = {
        songIds: [...snapshot.songIds],
        transitions: { ...snapshot.transitions },
        breaks: snapshot.breaks.map((b) => ({ ...b })),
    };
    return setlistMeta(setlistId, r);
}

// Stop sharing the draft with members. Clears the snapshot. A performed set is unaffected (its
// visibility is its status), matching unpublishSetlist.
export function unshareSetlistDraft(
    setlistId: string,
): SetlistMeta | undefined {
    const r = setlists.get(setlistId);
    if (!r) return undefined;
    if (r.status !== "performed") {
        r.shareDraft = false;
        r.draftOrder = null;
    }
    return setlistMeta(setlistId, r);
}

// Refresh the shared draft's order, but ONLY while the set is shared. The director's order-changing
// edits call this so the member preview tracks what the director sees. A no-op when not sharing (or
// once published/performed), so a mutation route can call it unconditionally after a re-draft.
export function syncSharedDraftOrder(
    setlistId: string,
    snapshot: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
    },
): void {
    const r = setlists.get(setlistId);
    if (!r || !r.shareDraft || r.status === "performed") return;
    r.draftOrder = {
        songIds: [...snapshot.songIds],
        transitions: { ...snapshot.transitions },
        breaks: snapshot.breaks.map((b) => ({ ...b })),
    };
}

// Refresh a PUBLISHED set's frozen order, but ONLY while it is published and not performed, and
// WITHOUT touching the publish time. A published set stays editable, so the director's order edits
// call this to keep the member-visible snapshot on the current order — no unpublish/republish to push
// a change. It freezes for good only when the set is performed (an immutable record, guarded out
// here). published_at is left as-is, so the member-visibility gate is unchanged. A no-op when the set
// is not published, so a mutation route can call it unconditionally after a re-draft. Mirror of
// syncSharedDraftOrder for the frozen snapshot.
export function syncPublishedOrder(
    setlistId: string,
    snapshot: {
        songIds: string[];
        transitions: Record<string, number>;
        breaks: SetBreak[];
    },
): void {
    const r = setlists.get(setlistId);
    if (!r || !r.published || r.status === "performed") return;
    r.published = {
        songIds: [...snapshot.songIds],
        transitions: { ...snapshot.transitions },
        breaks: snapshot.breaks.map((b) => ({ ...b })),
        at: r.published.at, // keep the original publish time; only the order changes
    };
}

// --- Performed history ----------------------------------------------------

export interface PerformedSet {
    setlistId: string;
    setlistPublicId: string; // the setlist's URL token; never replaces setlistId (the uuid)
    eventId: string;
    eventName: string;
    name: string | null;
    date: string;
    songs: SongRow[]; // the frozen order, resolved to songs (an archived one still resolves)
    notes: Record<string, string>; // per-song annotations, keyed by songId
    transitions: Record<string, number>; // frozen per-song segue overrides, keyed by songId
    breaks: SetBreak[]; // frozen breaks (intermissions) at their ordinal slots
    padding: { perSongSeconds: number; perSetSeconds: number }; // the event's, for the clock
}

// The frozen set for a performed setlist, or undefined if it is not performed. The
// read-only setlist view and the print sheet use this instead of re-drafting, so a
// historical set never changes after the fact.
export function getPerformedSet(setlistId: string): PerformedSet | undefined {
    const rec = setlists.get(setlistId);
    if (!rec || rec.status !== "performed" || !rec.performed) return undefined;
    const event = events.find((e) => e.id === rec.eventId);
    // Prefer the frozen snapshot (song metadata + event name/padding as they were at perform time);
    // fall back to live reads for a set performed before the snapshot existed.
    const snap = rec.performed.snapshot;
    const resolved = snap
        ? snap.songs.map((s) => ({ ...s }))
        : rec.performed.songIds
              .map((id) => songs.find((s) => s.id === id))
              .filter((s): s is SongRow => s !== undefined)
              .map((s) => ({ ...s }));
    // Scope transitions to the frozen order on read, exactly as notes are (getItemNotes),
    // so the two frozen fields behave identically and neither carries phantom songs.
    const frozen = rec.performed.transitions;
    const transitions: Record<string, number> = {};
    for (const id of rec.performed.songIds) {
        if (frozen[id] !== undefined) transitions[id] = frozen[id];
    }
    return {
        setlistId,
        setlistPublicId: setlistId,
        eventId: rec.eventId,
        eventName: snap?.eventName ?? event?.name ?? "Event",
        name: rec.name,
        date: rec.performed.date,
        songs: resolved,
        notes: getItemNotes(setlistId, rec.performed.songIds),
        transitions,
        breaks: rec.performed.breaks.map((b) => ({ ...b })),
        padding:
            snap?.padding ??
            (event
                ? {
                      perSongSeconds: event.resolved.padding.perSongSeconds,
                      perSetSeconds: event.resolved.padding.perSetSeconds,
                  }
                : { ...DEFAULT_PADDING }),
    };
}

// The member-visible frozen set: a performed set (the gig happened) or a published one (the
// director shared it). Same render shape either way; `status`/`performedDate` let the call sheet
// tell "the set as performed" from "the plan for the night".
export interface PublishedSet {
    setlistId: string;
    setlistPublicId: string; // the setlist's URL token; never replaces setlistId (the uuid)
    eventId: string;
    eventName: string;
    name: string | null;
    status: SetlistStatus; // 'performed' or the published draft/final status
    performedDate: string | null; // the frozen performed date, else null (a published-upcoming set)
    songs: SongRow[]; // the frozen order, resolved to songs
    notes: Record<string, string>; // per-song staging notes, keyed by songId — read LIVE, not frozen
    transitions: Record<string, number>; // frozen per-song segues, keyed by songId
    breaks: SetBreak[]; // frozen breaks at their ordinal slots
    padding: { perSongSeconds: number; perSetSeconds: number };
}

// The ordered set a member reads on the call sheet: the performed order when the set has been
// performed, else the published snapshot. A live draft is never returned (member visibility is
// performed OR published). Only the order + segues + breaks are frozen; notes are read live and
// scoped to the order, so a director's staging note stays current after publish.
export function getPublishedSet(setlistId: string): PublishedSet | undefined {
    const rec = setlists.get(setlistId);
    if (!rec) return undefined;
    const performed = rec.status === "performed";
    const frozen = performed ? rec.performed : rec.published;
    if (!frozen) return undefined;
    const event = events.find((e) => e.id === rec.eventId);
    // A performed set reads its frozen snapshot (immutable history); a published-not-performed set is
    // still editable, so its songs and padding read live.
    const snap = performed ? rec.performed?.snapshot : undefined;
    const resolved = snap
        ? snap.songs.map((s) => ({ ...s }))
        : frozen.songIds
              .map((id) => songs.find((s) => s.id === id))
              .filter((s): s is SongRow => s !== undefined)
              .map((s) => ({ ...s }));
    const transitions: Record<string, number> = {};
    for (const id of frozen.songIds) {
        if (frozen.transitions[id] !== undefined)
            transitions[id] = frozen.transitions[id];
    }
    return {
        setlistId,
        setlistPublicId: setlistId,
        eventId: rec.eventId,
        eventName: snap?.eventName ?? event?.name ?? "Event",
        name: rec.name,
        status: rec.status,
        performedDate: performed && rec.performed ? rec.performed.date : null,
        songs: resolved,
        notes: getItemNotes(setlistId, frozen.songIds),
        transitions,
        breaks: frozen.breaks.map((b) => ({ ...b })),
        padding:
            snap?.padding ??
            (event
                ? {
                      perSongSeconds: event.resolved.padding.perSongSeconds,
                      perSetSeconds: event.resolved.padding.perSetSeconds,
                  }
                : { ...DEFAULT_PADDING }),
    };
}

// The member-visible LIVE draft: the shared order snapshot resolved to songs, in the same shape as
// getPublishedSet so the call sheet renders it uniformly (with a "draft" banner the caller adds).
// Returns undefined unless the set is shared (share_draft on) and NOT already published or performed
// — those read through getPublishedSet (frozen). The RLS setlist_read policy enforces the same
// member-visibility gate; this is the app-layer half. Notes stay out: a draft's staging notes are
// director-internal, so the member preview shows the running order and roles, not the annotations.
export function getSharedDraft(setlistId: string): PublishedSet | undefined {
    const rec = setlists.get(setlistId);
    if (!rec) return undefined;
    if (rec.status === "performed" || rec.published) return undefined; // frozen sets read elsewhere
    if (!rec.shareDraft || !rec.draftOrder) return undefined;
    const event = events.find((e) => e.id === rec.eventId);
    const resolved = rec.draftOrder.songIds
        .map((id) => songs.find((s) => s.id === id))
        .filter((s): s is SongRow => s !== undefined)
        .map((s) => ({ ...s }));
    const transitions: Record<string, number> = {};
    for (const id of rec.draftOrder.songIds) {
        if (rec.draftOrder.transitions[id] !== undefined)
            transitions[id] = rec.draftOrder.transitions[id];
    }
    return {
        setlistId,
        setlistPublicId: setlistId,
        eventId: rec.eventId,
        eventName: event?.name ?? "Event",
        name: rec.name,
        status: rec.status,
        performedDate: null,
        songs: resolved,
        notes: {},
        transitions,
        breaks: rec.draftOrder.breaks.map((b) => ({ ...b })),
        padding: event
            ? {
                  perSongSeconds: event.resolved.padding.perSongSeconds,
                  perSetSeconds: event.resolved.padding.perSetSeconds,
              }
            : { ...DEFAULT_PADDING },
    };
}

export interface HistoryEntry {
    setlistId: string;
    setlistPublicId: string; // the setlist's URL token; never replaces setlistId (the uuid)
    eventId: string;
    eventName: string;
    name: string | null;
    date: string;
    titles: string[];
}

// Every performed set, most recent first, for the history archive.
export function getSetlistHistory(): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (const [id, rec] of setlists) {
        if (rec.status !== "performed" || !rec.performed) continue;
        const event = events.find((e) => e.id === rec.eventId);
        out.push({
            setlistId: id,
            setlistPublicId: id,
            eventId: rec.eventId,
            eventName:
                rec.performed.snapshot?.eventName ?? event?.name ?? "Event",
            name: rec.name,
            date: rec.performed.date,
            // Frozen titles when the snapshot exists, else live (a pre-snapshot performed set).
            titles: rec.performed.snapshot
                ? rec.performed.snapshot.songs.map((s) => s.title)
                : rec.performed.songIds.map(
                      (sid) => songs.find((s) => s.id === sid)?.title ?? sid,
                  ),
        });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
}

// Clone a performed set into a fresh draft on a target event: its ends become
// open/close and the rest are kept, so a past program is a starting point. Reuses
// the setlist + pin machinery.
export function cloneSetlist(
    sourceSetlistId: string,
    targetEventId: string,
): SetlistMeta | undefined {
    const src = setlists.get(sourceSetlistId);
    if (!src || !src.performed) return undefined;
    const ids = src.performed.songIds;
    const meta = createSetlist(
        targetEventId,
        src.name ? `${src.name} (clone)` : "Cloned set",
    );
    if (!meta) return undefined; // target event not found
    const open = ids[0] ?? null;
    const close = ids.length > 1 ? ids[ids.length - 1]! : null;
    const keep = ids.filter((id) => id !== open && id !== close);
    setPins(meta.id, { open, close, keep, excluded: [] });
    return meta;
}

// --- Events ---------------------------------------------------------------

export interface EventInput {
    name: string;
    venue: string | null;
    status: EventStatus;
    kind: EventKind;
    eventTypeId: string | null;
    eventDate: string | null;
    targetDurationSeconds: number | null;
    maxDurationSeconds: number | null;
    allowsOnBook: boolean;
    allowsExplicit: boolean;
    allowsAccompaniment: boolean;
    perSongSeconds: number;
    perSetSeconds: number;
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}

// Deep copy so callers never hold a handle that mutates the store.
const cloneEvent = (e: EventRow): EventRow => ({
    id: e.id,
    publicId: e.publicId,
    name: e.name,
    venue: e.venue,
    status: e.status,
    kind: e.kind,
    eventTypeId: e.eventTypeId,
    resolved: { ...e.resolved, padding: { ...e.resolved.padding } },
    availability: e.availability.map((a) => ({ ...a })),
    excludeTags: [...e.excludeTags],
    preferTags: [...e.preferTags],
    requireTags: [...e.requireTags],
});

// Fail-closed by kind: the default is 'gig', so every existing gig seam (dashboard,
// events list, clone/playground/what-if pickers) stays gig-only for free. Only the
// surfaces that should show rehearsals (member schedule, the Rehearsals tab) pass a
// kind, and 'all' returns both.
export function listEvents(opts?: { kind?: EventKind | "all" }): EventRow[] {
    const kind = opts?.kind ?? "gig";
    return events
        .filter((e) => kind === "all" || e.kind === kind)
        .map(cloneEvent);
}

export function getEvent(id: string): EventRow | undefined {
    const e = events.find((x) => x.id === id);
    return e ? { ...cloneEvent(e), version: ver(id) } : undefined;
}

/** Setlist ids bound to an event. Every event has at least one. */
export function getEventSetlists(eventId: string): string[] {
    return [...setlists.entries()]
        .filter(([, r]) => r.eventId === eventId)
        .map(([id]) => id);
}

/** A rehearsal's agenda, in order. Empty for a rehearsal with no plan yet. */
export function getRehearsalAgenda(eventId: string): RehearsalAgendaItem[] {
    return (rehearsalAgendas.get(eventId) ?? []).map((i) => ({ ...i }));
}

/**
 * Replace a rehearsal's agenda with the given ordered items. Guards kind like the
 * save_rehearsal_agenda RPC: a gig has a setlist, not an agenda, so it can never
 * acquire one. Unknown songs are dropped (mirrors the FK to song).
 */
export function saveRehearsalAgenda(
    eventId: string,
    items: RehearsalAgendaItem[],
): void {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    if (event.kind !== "rehearsal")
        throw new Error("saveRehearsalAgenda: event is not a rehearsal");
    const known = new Set(songs.map((s) => s.id));
    const seen = new Set<string>();
    const cleaned = items
        .filter(
            (i) =>
                known.has(i.songId) &&
                !seen.has(i.songId) &&
                (seen.add(i.songId), true),
        )
        .map((i) => ({
            songId: i.songId,
            reason: i.reason ?? null,
            note: i.note?.trim() ? i.note.trim() : null,
        }));
    rehearsalAgendas.set(eventId, cleaned);
}

/** A gig's prep targets: song ids to have ready by its date. Empty for a gig with none. */
export function getPrepTargets(eventId: string): string[] {
    return [...(prepTargets.get(eventId) ?? [])];
}

/**
 * Replace a gig's prep-target set. Guards kind like the save_prep_targets RPC: only a gig
 * has targets (a rehearsal is the prep). Unknown songs dropped, deduped (mirrors the FK and
 * the unique(event_id, song_id) constraint).
 */
export function savePrepTargets(eventId: string, songIds: string[]): void {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    if (event.kind !== "gig")
        throw new Error("savePrepTargets: event is not a gig");
    const known = new Set(songs.map((s) => s.id));
    const seen = new Set<string>();
    const cleaned = songIds.filter(
        (id) => known.has(id) && !seen.has(id) && (seen.add(id), true),
    );
    prepTargets.set(eventId, cleaned);
}

/**
 * Add or remove ONE song from a gig's prep targets, touching only that song's membership. The
 * setlist editor's per-row toggle uses this instead of a whole-set replace, so two concurrent
 * toggles of DIFFERENT songs never clobber each other. Kind-guarded to a gig like savePrepTargets.
 */
export function togglePrepTarget(
    eventId: string,
    songId: string,
    on: boolean,
): void {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    if (event.kind !== "gig")
        throw new Error("togglePrepTarget: event is not a gig");
    const current = prepTargets.get(eventId) ?? [];
    if (on) {
        if (!current.includes(songId) && songs.some((s) => s.id === songId))
            prepTargets.set(eventId, [...current, songId]);
    } else {
        prepTargets.set(
            eventId,
            current.filter((x) => x !== songId),
        );
    }
}

// Record what was rehearsed.
//
// Attendance is the fact of who came, distinct from RSVP intent (a missing row = not
// recorded). One list per event; the mock's projection of the attendance table.
export interface AttendanceItem {
    memberId: string;
    present: boolean;
}
const attendance = new Map<string, AttendanceItem[]>();

/**
 * Stamp last_rehearsed for the songs actually run, monotonically (greatest): a later date
 * moves it forward, an earlier one is ignored, and running it twice is a no-op. Mirrors
 * mark_songs_rehearsed. Unknown song ids are skipped (the RPC's WHERE matches nothing).
 */
export function markSongsRehearsed(songIds: string[], date: string): void {
    const ids = new Set(songIds);
    for (const s of songs) {
        if (!ids.has(s.id)) continue;
        if (s.lastRehearsed === null || date > s.lastRehearsed)
            s.lastRehearsed = date;
    }
}

/** An event's recorded attendance. Empty when nothing has been recorded yet. */
export function getAttendance(eventId: string): AttendanceItem[] {
    return (attendance.get(eventId) ?? []).map((a) => ({ ...a }));
}

/**
 * Replace an event's attendance with the given rows. Deduped by member (last write wins),
 * unknown members dropped (mirrors the FK). Mirrors save_attendance.
 */
export function saveAttendance(eventId: string, rows: AttendanceItem[]): void {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    if (event.kind !== "rehearsal")
        throw new Error("saveAttendance: event is not a rehearsal");
    const known = new Set(members.map((m) => m.id));
    const byMember = new Map<string, boolean>();
    for (const r of rows)
        if (known.has(r.memberId)) byMember.set(r.memberId, r.present);
    attendance.set(
        eventId,
        [...byMember.entries()].map(([memberId, present]) => ({
            memberId,
            present,
        })),
    );
}

function toResolved(id: string, input: EventInput): ResolvedEvent {
    return {
        id,
        eventDate: input.eventDate,
        targetDurationSeconds: input.targetDurationSeconds,
        maxDurationSeconds: input.maxDurationSeconds,
        allowsOnBook: input.allowsOnBook,
        allowsExplicit: input.allowsExplicit,
        allowsAccompaniment: input.allowsAccompaniment,
        padding: {
            perSongSeconds: input.perSongSeconds,
            perSetSeconds: input.perSetSeconds,
        },
    };
}

export function createEvent(input: EventInput): EventRow {
    const id = newId("event");
    const row: EventRow = {
        id,
        publicId: id,
        name: input.name,
        venue: input.venue,
        status: input.status,
        kind: input.kind,
        eventTypeId: input.eventTypeId,
        resolved: toResolved(id, input),
        // No seeded RSVPs: members are pending until they respond, so an 'in' always means a real
        // confirmation, not a fabricated default. Mirrors save_event (migration ...049).
        availability: [],
        excludeTags: [...input.excludeTags],
        preferTags: [...input.preferTags],
        requireTags: [...input.requireTags],
    };
    events.push(row);
    // A gig gets a Main-set setlist so it is immediately draftable; a rehearsal does
    // not (its agenda is the rehearsal plan, added through the agenda planner). Mirrors save_event.
    if (input.kind === "gig") {
        setlists.set(`sl-${id}`, {
            eventId: id,
            programId: null,
            name: "Main set",
            status: "draft",
            pins: { ...EMPTY_PINS },
            performed: null,
            published: null,
            shareDraft: false,
            draftOrder: null,
            notes: {},
            transitions: {},
            breaks: [],
        });
    }
    return cloneEvent(row);
}

export function updateEvent(
    id: string,
    input: EventInput,
): EventRow | undefined {
    const row = events.find((e) => e.id === id);
    if (!row) return undefined;
    row.name = input.name;
    row.venue = input.venue;
    row.status = input.status;
    row.eventTypeId = input.eventTypeId;
    row.resolved = toResolved(id, input);
    row.excludeTags = [...input.excludeTags];
    row.preferTags = [...input.preferTags];
    row.requireTags = [...input.requireTags];
    return cloneEvent(row);
}

export type DeleteEventResult =
    | { ok: true }
    | { ok: false; reason: "not-found" | "has-performed" };

export function deleteEvent(id: string): DeleteEventResult {
    const idx = events.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, reason: "not-found" };
    // A performed setlist is an immutable historical record (frozen order + soloist
    // snapshots). Refuse to let event deletion cascade-wipe it; the event must be archived
    // instead. (The schema's setlist FK cascades, so a delete_event RPC enforces this there.)
    for (const r of setlists.values()) {
        if (r.eventId === id && r.status === "performed")
            return { ok: false, reason: "has-performed" };
    }
    events.splice(idx, 1);
    for (const [sid, r] of [...setlists.entries()]) {
        if (r.eventId === id) setlists.delete(sid);
    }
    return { ok: true };
}

export function setAvailability(
    eventId: string,
    availability: Availability[],
    expectedVersion: string,
): WriteResult {
    const row = events.find((e) => e.id === eventId);
    if (!row) return { ok: false, reason: "not_found" };
    if (ver(eventId) !== expectedVersion)
        return { ok: false, reason: "conflict" };
    row.availability = availability.map((a) => ({ ...a }));
    return { ok: true, version: bumpVersion(eventId) };
}

// The mock has no auth, so "who am I" is resolved here, and it is the single source of truth
// for the signed-in member in mock mode (getMyMembership reuses it, so identity and tier never
// disagree; the Supabase adapter instead resolves the caller from auth.uid()). Default: the
// ensemble's director, the common director-console loop. To browse the member views in the mock
// loop, set MOCK_MEMBER_ID: an exact active member id acts as that member; any other non-empty
// value acts as the first active non-director member (a zero-lookup "just show me a member"
// switch). Dev-only by construction, since env.ts fails closed on mock data in production.
export function mockSelf(): MemberRow | undefined {
    const override = process.env.MOCK_MEMBER_ID?.trim();
    if (override) {
        const exact = members.find(
            (m) => m.status === "active" && m.id === override,
        );
        if (exact) return exact;
        const firstMember = members.find(
            (m) => m.status === "active" && m.role !== "director",
        );
        if (firstMember) return firstMember;
    }
    return (
        members.find((m) => m.status === "active" && m.role === "director") ??
        members[0]
    );
}

// The signed-in member's own availability for one event. Upserts the one row,
// no version token (a self-write never replaces a whole collection, so there is nothing to clobber).
export function setMyAvailability(
    eventId: string,
    status: AvailabilityStatus,
): void {
    const me = mockSelf();
    // Match the supabase RPC, which raises for a non-existent event (or a caller who is not a member of
    // it): the rsvp route catches the throw and returns 400. A silent return would answer {ok:true} for
    // an event that does not exist — an RSVP that "saves" to nowhere.
    const event = events.find((e) => e.id === eventId);
    if (!me || !event)
        throw new Error("could not set availability: event not found");
    const row = event.availability.find((a) => a.memberId === me.id);
    if (row) row.status = status;
    else event.availability.push({ memberId: me.id, status });
    // Advance the event's optimistic-concurrency token (parity with set_my_availability, which now
    // bumps event.updated_at), so a director's guarded bulk RSVP save detects this member's change and
    // conflicts instead of silently overwriting it.
    bumpVersion(eventId);
}

// The signed-in member's own castings across songs, keyed by partId (one
// casting per part/member). Confidence here is the member's own self_reported value — under
// Supabase it's read through casting_visible, which already hides everyone else's. The
// member sets it via setMyConfidence (the set_my_confidence RPC); the director can see but
// not overwrite it (a trigger reverts a non-self write).
export interface MyCasting {
    partId: string;
    songId: string; // the part's song, so a caller can join castings to a set's songs (the gig call sheet)
    songTitle: string;
    partLabel: string;
    isLead: boolean;
    isSolo: boolean; // a solo names its own range; a section line inherits its section nominal
    confidence: Confidence | null;
    // Song-level context the practice view surfaces so a member can prepare a part
    // without opening the director's song page. All read off the web SongRow, not core Song.
    assessedReadiness: AssessedReadiness; // the director's read of the whole song
    bookStatus: BookStatus;
    chartRef: string | null;
    arranger: string | null;
    startKey: KeySig | null;
    endKey: KeySig | null; // where it lands if it modulates; null = ends as it started
    startPitch: string | null; // explicit pitch to blow; null = derive from startKey
    startTempoBpm: number | null;
    endTempoBpm: number | null; // closing tempo if it changes; null = constant
    // The PART's own range: populated for solos, null for section lines (which fall
    // back to their section nominal). Lets /me/parts fit a solo against the member's range.
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
}

export function listMyCastings(): MyCasting[] {
    const me = mockSelf();
    if (!me) return [];
    return castings
        .filter((c) => c.memberId === me.id)
        .map((c) => {
            const part = parts.find((p) => p.id === c.partId);
            const song = part
                ? songs.find((s) => s.id === part.songId)
                : undefined;
            return {
                partId: c.partId,
                songId: part?.songId ?? "",
                songTitle: song?.title ?? "(unknown song)",
                partLabel: part?.label ?? "(part)",
                isLead: c.isPrimary,
                isSolo: part?.isSolo ?? false,
                confidence: c.confidence,
                assessedReadiness: song?.assessedReadiness ?? "dormant",
                bookStatus: song?.bookStatus ?? "off-book",
                chartRef: song?.chartRef ?? null,
                arranger: song?.arranger ?? null,
                startKey: song?.startKey ?? null,
                endKey: song?.endKey ?? null,
                startPitch: song?.startPitch ?? null,
                startTempoBpm: song?.startTempoBpm ?? null,
                endTempoBpm: song?.endTempoBpm ?? null,
                rangeLowMidi: part?.rangeLowMidi ?? null,
                rangeHighMidi: part?.rangeHighMidi ?? null,
            };
        });
}

export function setMyConfidence(
    partId: string,
    confidence: Confidence | null,
): void {
    const me = mockSelf();
    if (!me) return;
    const c = castings.find((x) => x.partId === partId && x.memberId === me.id);
    if (c) c.confidence = confidence;
}

// A member's per-part coverage: for each part they are cast on, how many singers the part
// needs and who else covers it, so /me/parts can flag a part with no backup. A section-mate's
// self-confidence is included only when the ensemble shares confidence (mirroring what
// casting_visible enforces under Supabase); the member always sees their own.
export interface PartCover {
    memberId: string;
    displayName: string;
    isLead: boolean;
    isSelf: boolean;
    confidence: Confidence | null; // self always; others only when confidenceVisibility='shared'
}
export interface PartCoverage {
    partId: string;
    countNeeded: number;
    covers: PartCover[]; // every member cast on the part, the viewer first, then others by name
}

const orderCovers = (a: PartCover, b: PartCover) =>
    a.isSelf === b.isSelf
        ? a.displayName.localeCompare(b.displayName)
        : a.isSelf
          ? -1
          : 1;

export function listMyPartCoverage(): PartCoverage[] {
    const me = mockSelf();
    if (!me) return [];
    // Mirror casting_visible's three "show the self-report" branches: it is the caller's own row,
    // the caller is a director, or the ensemble shares confidence. Otherwise a peer's read is null.
    const shared = ensembleSettings.confidenceVisibility === "shared";
    const viewerIsDirector = me.role === "director";
    const myPartIds = castings
        .filter((c) => c.memberId === me.id)
        .map((c) => c.partId);
    return myPartIds.map((partId) => {
        const part = parts.find((p) => p.id === partId);
        const covers: PartCover[] = castings
            .filter((c) => c.partId === partId)
            .map((c) => {
                const isSelf = c.memberId === me.id;
                return {
                    memberId: c.memberId,
                    displayName:
                        members.find((m) => m.id === c.memberId)?.displayName ??
                        "(unknown)",
                    isLead: c.isPrimary,
                    isSelf,
                    confidence:
                        isSelf || viewerIsDirector || shared
                            ? c.confidence
                            : null,
                };
            })
            .sort(orderCovers);
        return { partId, countNeeded: part?.countNeeded ?? 1, covers };
    });
}

// --- Songs ----------------------------------------------------------------

export function listSongs(): SongRow[] {
    return songs.map((s) => ({ ...s }));
}

export function getSong(id: string): SongRow | undefined {
    const row = songs.find((s) => s.id === id);
    return row ? { ...row, version: ver(id) } : undefined;
}

export function getSongParts(songId: string): MockPart[] {
    return parts
        .filter((p) => p.songId === songId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => ({ ...p }));
}

export function getSongCasting(songId: string): MockCasting[] {
    const partIds = new Set(
        parts.filter((p) => p.songId === songId).map((p) => p.id),
    );
    return castings.filter((c) => partIds.has(c.partId)).map((c) => ({ ...c }));
}

// One batched read of the whole book's parts + castings. A caller that needs coverage for many songs
// at once (the dashboard, the insights surfaces, the rehearsal agenda, the playground) reshapes this
// in memory via buildCoverage instead of firing getSongParts + getSongCasting per song — the N+1 that
// made those pages issue ~3 queries per active song. Element shapes match the per-song reads exactly,
// so the regrouping is identical. Parts come back sorted by sortOrder (the adapter orders to match),
// so within-song part order agrees across the mock and Supabase.
export function getEnsembleCoverage(): {
    parts: MockPart[];
    castings: MockCasting[];
} {
    return {
        parts: [...parts]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((p) => ({ ...p })),
        castings: castings.map((c) => ({ ...c })),
    };
}

// Active, singing roster, projected to the drafter's Member shape. Used by casting
// and RSVP, which only concern members who actually perform.
export function listMembers(): Member[] {
    return members
        .filter((m) => m.status === "active" && m.singing)
        .map((m) => ({ id: m.id, displayName: m.displayName }));
}

// --- Roster (full member records, incl. archived) -------------------------

const cloneMember = (m: MemberRow): MemberRow => ({
    ...m,
    sections: m.sections.map((s) => ({ ...s })),
});

export function listRoster(): MemberRow[] {
    return members.map(cloneMember);
}

export function getMember(id: string): MemberRow | undefined {
    const m = members.find((x) => x.id === id);
    return m ? cloneMember(m) : undefined;
}

export interface MemberInput {
    displayName: string;
    role: MemberRole;
    singing: boolean;
    sections: MemberSection[];
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
}

export function createMember(input: MemberInput): MemberRow {
    const id = newId("member");
    const row: MemberRow = {
        id,
        publicId: id,
        displayName: input.displayName,
        role: input.role,
        status: "active",
        singing: input.singing,
        sections: input.sections.map((s) => ({ ...s })),
        rangeLowMidi: input.rangeLowMidi,
        rangeHighMidi: input.rangeHighMidi,
        // A freshly added seat has no login and no invite until the director sends one.
        claimed: false,
        inviteEmail: null,
        invitedAt: null,
    };
    members.push(row);
    return cloneMember(row);
}

// Record (or update) the email a pending seat was invited under. The director sends
// the email separately; this just stores who the seat is for so the roster shows it
// and a claim can match it. Mirrors the supabase adapter's RLS-gated write + the
// member_one_pending_invite uniqueness; the mock has no auth, so it never rejects on
// tier and "pending/unclaimed" stands in for "user_id is null".
export type InviteResult =
    | { ok: true }
    // A dead-end invite: the email already belongs to a claimed seat here (active member, or an
    // archived one), so claim_membership could never bind it. The director should reactivate that
    // seat instead. memberName lets the caller name the person in the message.
    | {
          ok: false;
          reason: "already_member" | "removed_member";
          memberName: string;
      }
    | {
          ok: false;
          reason: "not_found" | "forbidden" | "claimed" | "duplicate";
      };

// _tokenHash is the SHA-256 of the per-seat invite token. The mock has no claim flow,
// so it just records the email + timestamp; the hash matters only on the supabase path.
export function inviteMember(
    id: string,
    email: string,
    _tokenHash: string,
): InviteResult {
    const normalized = email.trim().toLowerCase();
    const row = members.find((m) => m.id === id);
    if (!row) return { ok: false, reason: "not_found" };
    // One pending seat per email (the schema's partial unique index).
    if (members.some((m) => m.id !== id && m.inviteEmail === normalized)) {
        return { ok: false, reason: "duplicate" };
    }
    row.inviteEmail = normalized;
    row.invitedAt = new Date().toISOString();
    return { ok: true };
}

// What a member may change about their OWN record: their display name and vocal range.
// Role, sections, status, and the account link stay director-controlled (and, under
// Supabase, are untouchable by the update_my_profile RPC). Mirrors update_my_profile.
export interface ProfileInput {
    displayName: string;
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
}

export function updateMyProfile(
    memberId: string,
    input: ProfileInput,
): MemberRow | null {
    const row = members.find((m) => m.id === memberId);
    if (!row) return null;
    row.displayName = input.displayName;
    row.rangeLowMidi = input.rangeLowMidi;
    row.rangeHighMidi = input.rangeHighMidi;
    return cloneMember(row);
}

// Lower is more confident. Used to promote the strongest remaining cover to lead.
// Null (un-reported) reads as solid-equivalent, matching readiness's confidencePenalty.
const CONFIDENCE_RANK: Record<Confidence, number> = {
    solid: 0,
    shaky: 1,
    learning: 2,
};
const confidenceRank = (c: Confidence | null): number =>
    c ? CONFIDENCE_RANK[c] : 0;

// Drop a member's casting and RSVPs everywhere, so drafts reflect their loss
// from the pool. Shared by archiving and by turning a member non-singing. If
// removing a lead leaves a part with other covers but no lead, promote one, so
// the drafter's two lead-resolution paths cannot disagree.
function pruneMemberCoverage(id: string): void {
    const removedLeads = castings.filter(
        (c) => c.memberId === id && c.isPrimary,
    );
    for (let i = castings.length - 1; i >= 0; i--) {
        if (castings[i]!.memberId === id) castings.splice(i, 1);
    }
    for (const lead of removedLeads) {
        const remaining = castings.filter((c) => c.partId === lead.partId);
        if (remaining.length > 0 && !remaining.some((c) => c.isPrimary)) {
            // Promote the most-confident remaining cover, not whichever sits first in
            // the array. Ties keep the earlier one (reduce returns `a` on equal rank).
            const best = remaining.reduce((a, b) =>
                confidenceRank(b.confidence) < confidenceRank(a.confidence)
                    ? b
                    : a,
            );
            best.isPrimary = true;
        }
    }
    for (const ev of events) {
        ev.availability = ev.availability.filter((a) => a.memberId !== id);
    }
}

// A write either succeeds or is rejected for a named reason. 'last-director'
// guards a domain invariant: a group must keep at least one active director, or
// (once writes are RLS-scoped to directors) no one could manage the roster.
export type MemberWriteResult =
    | { ok: true; member: MemberRow }
    | { ok: false; reason: "not-found" | "last-director" };

const activeDirectorsExcluding = (id: string): number =>
    members.filter(
        (m) => m.id !== id && m.status === "active" && m.role === "director",
    ).length;

export function updateMember(
    id: string,
    input: MemberInput,
): MemberWriteResult {
    const row = members.find((m) => m.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    // Don't demote the only active director.
    if (
        row.status === "active" &&
        row.role === "director" &&
        input.role !== "director" &&
        activeDirectorsExcluding(id) === 0
    ) {
        return { ok: false, reason: "last-director" };
    }
    const wasSinging = row.singing;
    row.displayName = input.displayName;
    row.role = input.role;
    row.singing = input.singing;
    row.sections = input.sections.map((s) => ({ ...s }));
    row.rangeLowMidi = input.rangeLowMidi;
    row.rangeHighMidi = input.rangeHighMidi;
    // Turning non-singing drops them from the pool; prune like archiving.
    if (wasSinging && !input.singing) pruneMemberCoverage(id);
    return { ok: true, member: cloneMember(row) };
}

export function setMemberStatus(
    id: string,
    status: MemberStatus,
): MemberWriteResult {
    const row = members.find((m) => m.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    // Don't deactivate the only active director.
    if (
        status === "inactive" &&
        row.status === "active" &&
        row.role === "director" &&
        activeDirectorsExcluding(id) === 0
    ) {
        return { ok: false, reason: "last-director" };
    }
    row.status = status;
    if (status === "inactive") {
        pruneMemberCoverage(id);
        // Revoke any pending invite on deactivation (parity with set_member_status): a removed seat
        // must not keep a claimable invite. Reactivation is the path back and needs no stale invite.
        row.inviteEmail = null;
        row.invitedAt = null;
    }
    return { ok: true, member: cloneMember(row) };
}

export function listTags(): TagRow[] {
    return [...tags]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => ({ ...t }));
}

// --- Tags (the style vocabulary) ------------------------------------------

export interface TagInput {
    name: string;
    category: Tag["category"];
}

export type TagWriteResult =
    | { ok: true; tag: TagRow }
    | { ok: false; reason: "duplicate" | "not-found" };

const tagNameTaken = (name: string, exceptId?: string): boolean =>
    tags.some(
        (t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase(),
    );

// How many songs and events reference each tag (by its name, the mock's resolved
// projection of song_tag / event_tag), keyed by tag id.
export function tagUsage(): Record<
    string,
    { songs: number; events: number; eventTypes: number }
> {
    const out: Record<
        string,
        { songs: number; events: number; eventTypes: number }
    > = {};
    for (const t of tags) out[t.id] = { songs: 0, events: 0, eventTypes: 0 };
    const idByName = new Map(tags.map((t) => [t.name, t.id]));
    for (const s of songs) {
        for (const t of s.tags) {
            const id = idByName.get(t.name);
            if (id && out[id]) out[id]!.songs += 1;
        }
    }
    for (const e of events) {
        for (const n of new Set([
            ...e.excludeTags,
            ...e.preferTags,
            ...e.requireTags,
        ])) {
            const id = idByName.get(n);
            if (id && out[id]) out[id]!.events += 1;
        }
    }
    for (const et of eventTypes) {
        for (const n of new Set([
            ...et.excludeTags,
            ...et.preferTags,
            ...et.requireTags,
        ])) {
            const id = idByName.get(n);
            if (id && out[id]) out[id]!.eventTypes += 1;
        }
    }
    return out;
}

export function createTag(input: TagInput): TagWriteResult {
    if (tagNameTaken(input.name)) return { ok: false, reason: "duplicate" };
    const sortOrder =
        tags.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
    const row: TagRow = {
        id: newId("tag"),
        name: input.name,
        category: input.category,
        sortOrder,
    };
    tags.push(row);
    return { ok: true, tag: { ...row } };
}

// Rename / recategorize, then cascade into the songs and events that reference
// this tag by name, so the mock's denormalized copies track the vocabulary the
// way the schema's id joins would (a tag rename is invisible to associations).
export function updateTag(id: string, input: TagInput): TagWriteResult {
    const row = tags.find((t) => t.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    if (tagNameTaken(input.name, id)) return { ok: false, reason: "duplicate" };
    const oldName = row.name;
    row.name = input.name;
    row.category = input.category;
    for (const s of songs) {
        s.tags = s.tags.map((t) =>
            t.name === oldName
                ? { name: input.name, category: input.category }
                : t,
        );
    }
    if (oldName !== input.name) {
        for (const e of events) {
            e.excludeTags = [
                ...new Set(
                    e.excludeTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
            e.preferTags = [
                ...new Set(
                    e.preferTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
            e.requireTags = [
                ...new Set(
                    e.requireTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
        }
        for (const et of eventTypes) {
            et.excludeTags = [
                ...new Set(
                    et.excludeTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
            et.preferTags = [
                ...new Set(
                    et.preferTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
            et.requireTags = [
                ...new Set(
                    et.requireTags.map((n) => (n === oldName ? input.name : n)),
                ),
            ];
        }
    }
    return { ok: true, tag: { ...row } };
}

export type TagDeleteResult =
    | {
          ok: true;
          removedFromSongs: number;
          removedFromEvents: number;
          removedFromEventTypes: number;
      }
    | { ok: false; reason: "not-found" };

// Delete cascades (schema: song_tag / event_tag / event_type_tag are ON DELETE
// CASCADE): drop the tag from every song, event, and event type that carried it.
export function deleteTag(id: string): TagDeleteResult {
    const row = tags.find((t) => t.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    const name = row.name;
    let removedFromSongs = 0;
    for (const s of songs) {
        const before = s.tags.length;
        s.tags = s.tags.filter((t) => t.name !== name);
        if (s.tags.length !== before) removedFromSongs += 1;
    }
    let removedFromEvents = 0;
    for (const e of events) {
        const had =
            e.excludeTags.includes(name) ||
            e.preferTags.includes(name) ||
            e.requireTags.includes(name);
        e.excludeTags = e.excludeTags.filter((n) => n !== name);
        e.preferTags = e.preferTags.filter((n) => n !== name);
        e.requireTags = e.requireTags.filter((n) => n !== name);
        if (had) removedFromEvents += 1;
    }
    let removedFromEventTypes = 0;
    for (const et of eventTypes) {
        const had =
            et.excludeTags.includes(name) ||
            et.preferTags.includes(name) ||
            et.requireTags.includes(name);
        et.excludeTags = et.excludeTags.filter((n) => n !== name);
        et.preferTags = et.preferTags.filter((n) => n !== name);
        et.requireTags = et.requireTags.filter((n) => n !== name);
        if (had) removedFromEventTypes += 1;
    }
    tags.splice(tags.indexOf(row), 1);
    return {
        ok: true,
        removedFromSongs,
        removedFromEvents,
        removedFromEventTypes,
    };
}

// Total, collision-free reorder (same shape as reorderVoiceParts): supplied ids
// first, then any omitted tags in their current order, renumbered 0..n-1.
export function reorderTags(orderedIds: string[]): void {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of orderedIds) {
        if (!seen.has(id) && tags.some((t) => t.id === id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    const remaining = [...tags]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => t.id)
        .filter((id) => !seen.has(id));
    [...ordered, ...remaining].forEach((id, i) => {
        const row = tags.find((t) => t.id === id);
        if (row) row.sortOrder = i;
    });
}

// --- Padding profiles & event types (event presets) -----------------------

export function listPaddingProfiles(): PaddingProfileRow[] {
    return paddingProfiles.map((p) => ({ ...p }));
}

export function listEventTypes(): EventTypeRow[] {
    return [...eventTypes]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => ({
            ...t,
            excludeTags: [...t.excludeTags],
            preferTags: [...t.preferTags],
            requireTags: [...t.requireTags],
        }));
}

// The resolved defaults a type stamps onto an event: padding from its profile (or
// DEFAULT_PADDING if none/dangling), the policy flags, and its tag rules (exclude-wins).
export function resolveEventTypePreset(
    typeId: string,
): ResolvedEventTypePreset | undefined {
    const t = eventTypes.find((x) => x.id === typeId);
    if (!t) return undefined;
    const pp = t.paddingProfileId
        ? paddingProfiles.find((p) => p.id === t.paddingProfileId)
        : undefined;
    return {
        allowsOnBook: t.defaultAllowsOnBook,
        allowsExplicit: t.defaultAllowsExplicit,
        allowsAccompaniment: t.defaultAllowsAccompaniment,
        perSongSeconds: pp?.perSongSeconds ?? DEFAULT_PADDING.perSongSeconds,
        perSetSeconds: pp?.perSetSeconds ?? DEFAULT_PADDING.perSetSeconds,
        excludeTags: [...t.excludeTags],
        preferTags: t.preferTags.filter((n) => !t.excludeTags.includes(n)),
        requireTags: t.requireTags.filter((n) => !t.excludeTags.includes(n)),
    };
}

// Presets keyed by type id, for the event form to prefill / re-apply client-side.
export function eventTypePresets(): Record<string, ResolvedEventTypePreset> {
    const out: Record<string, ResolvedEventTypePreset> = {};
    for (const t of eventTypes) {
        const preset = resolveEventTypePreset(t.id);
        if (preset) out[t.id] = preset;
    }
    return out;
}

// How many event types reference each padding profile (its only referrer — events
// snapshot resolved values, they don't point at a profile). Keyed by profile id.
export function paddingProfileUsage(): Record<string, { eventTypes: number }> {
    const out: Record<string, { eventTypes: number }> = {};
    for (const p of paddingProfiles) out[p.id] = { eventTypes: 0 };
    for (const t of eventTypes) {
        if (t.paddingProfileId && out[t.paddingProfileId])
            out[t.paddingProfileId]!.eventTypes += 1;
    }
    return out;
}

export interface PaddingProfileInput {
    name: string;
    perSongSeconds: number;
    perSetSeconds: number;
}
export type PaddingProfileWriteResult =
    | { ok: true; profile: PaddingProfileRow }
    | { ok: false; reason: "duplicate" | "not-found" };

const profileNameTaken = (name: string, exceptId?: string): boolean =>
    paddingProfiles.some(
        (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(),
    );

export function createPaddingProfile(
    input: PaddingProfileInput,
): PaddingProfileWriteResult {
    if (profileNameTaken(input.name)) return { ok: false, reason: "duplicate" };
    const row: PaddingProfileRow = {
        id: newId("pp"),
        name: input.name,
        perSongSeconds: input.perSongSeconds,
        perSetSeconds: input.perSetSeconds,
    };
    paddingProfiles.push(row);
    return { ok: true, profile: { ...row } };
}

export function updatePaddingProfile(
    id: string,
    input: PaddingProfileInput,
): PaddingProfileWriteResult {
    const row = paddingProfiles.find((p) => p.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    if (profileNameTaken(input.name, id))
        return { ok: false, reason: "duplicate" };
    row.name = input.name;
    row.perSongSeconds = input.perSongSeconds;
    row.perSetSeconds = input.perSetSeconds;
    return { ok: true, profile: { ...row } };
}

export type PaddingProfileDeleteResult =
    | { ok: true; clearedFromTypes: number }
    | { ok: false; reason: "not-found" };

// Mirror the schema FK (event_type.padding_profile_id ON DELETE SET NULL): clear the
// reference on every event type that used it (they fall back to DEFAULT_PADDING).
export function deletePaddingProfile(id: string): PaddingProfileDeleteResult {
    const row = paddingProfiles.find((p) => p.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    let clearedFromTypes = 0;
    for (const t of eventTypes) {
        if (t.paddingProfileId === id) {
            t.paddingProfileId = null;
            clearedFromTypes += 1;
        }
    }
    paddingProfiles.splice(paddingProfiles.indexOf(row), 1);
    return { ok: true, clearedFromTypes };
}

export function eventTypeUsage(): Record<string, { events: number }> {
    const out: Record<string, { events: number }> = {};
    for (const t of eventTypes) out[t.id] = { events: 0 };
    for (const e of events) {
        if (e.eventTypeId && out[e.eventTypeId])
            out[e.eventTypeId]!.events += 1;
    }
    return out;
}

export interface EventTypeInput {
    name: string;
    paddingProfileId: string | null;
    defaultAllowsOnBook: boolean;
    defaultAllowsExplicit: boolean;
    defaultAllowsAccompaniment: boolean;
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}
export type EventTypeWriteResult =
    | { ok: true; eventType: EventTypeRow }
    | { ok: false; reason: "duplicate" | "not-found" };

const eventTypeNameTaken = (name: string, exceptId?: string): boolean =>
    eventTypes.some(
        (t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase(),
    );

// Honor a profile reference only if it exists; else null (the type falls back to
// DEFAULT_PADDING). Mirrors the schema's SET NULL tolerance.
const validProfileId = (id: string | null): string | null =>
    id && paddingProfiles.some((p) => p.id === id) ? id : null;

const cloneEventType = (t: EventTypeRow): EventTypeRow => ({
    ...t,
    excludeTags: [...t.excludeTags],
    preferTags: [...t.preferTags],
    requireTags: [...t.requireTags],
});

export function createEventType(input: EventTypeInput): EventTypeWriteResult {
    if (eventTypeNameTaken(input.name))
        return { ok: false, reason: "duplicate" };
    const sortOrder =
        eventTypes.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
    const row: EventTypeRow = {
        id: newId("et"),
        name: input.name,
        sortOrder,
        paddingProfileId: validProfileId(input.paddingProfileId),
        defaultAllowsOnBook: input.defaultAllowsOnBook,
        defaultAllowsExplicit: input.defaultAllowsExplicit,
        defaultAllowsAccompaniment: input.defaultAllowsAccompaniment,
        excludeTags: [...input.excludeTags],
        preferTags: input.preferTags.filter(
            (n) => !input.excludeTags.includes(n),
        ),
        requireTags: input.requireTags.filter(
            (n) => !input.excludeTags.includes(n),
        ),
    };
    eventTypes.push(row);
    return { ok: true, eventType: cloneEventType(row) };
}

export function updateEventType(
    id: string,
    input: EventTypeInput,
): EventTypeWriteResult {
    const row = eventTypes.find((t) => t.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    if (eventTypeNameTaken(input.name, id))
        return { ok: false, reason: "duplicate" };
    row.name = input.name;
    row.paddingProfileId = validProfileId(input.paddingProfileId);
    row.defaultAllowsOnBook = input.defaultAllowsOnBook;
    row.defaultAllowsExplicit = input.defaultAllowsExplicit;
    row.defaultAllowsAccompaniment = input.defaultAllowsAccompaniment;
    row.excludeTags = [...input.excludeTags];
    row.preferTags = input.preferTags.filter(
        (n) => !input.excludeTags.includes(n),
    );
    row.requireTags = input.requireTags.filter(
        (n) => !input.excludeTags.includes(n),
    );
    return { ok: true, eventType: cloneEventType(row) };
}

export type EventTypeDeleteResult =
    | { ok: true; untypedEvents: number }
    | { ok: false; reason: "not-found" };

// Mirror the schema FK (event.event_type_id ON DELETE SET NULL): orphan the
// provenance pointer on referencing events; their snapshot is untouched.
export function deleteEventType(id: string): EventTypeDeleteResult {
    const row = eventTypes.find((t) => t.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    let untypedEvents = 0;
    for (const e of events) {
        if (e.eventTypeId === id) {
            e.eventTypeId = null;
            untypedEvents += 1;
        }
    }
    eventTypes.splice(eventTypes.indexOf(row), 1);
    return { ok: true, untypedEvents };
}

export function reorderEventTypes(orderedIds: string[]): void {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of orderedIds) {
        if (!seen.has(id) && eventTypes.some((t) => t.id === id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    const remaining = [...eventTypes]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => t.id)
        .filter((id) => !seen.has(id));
    [...ordered, ...remaining].forEach((id, i) => {
        const row = eventTypes.find((t) => t.id === id);
        if (row) row.sortOrder = i;
    });
}

// --- Voice parts (the section vocabulary) ---------------------------------

export function listVoiceParts(): VoicePartRow[] {
    return [...voiceParts]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((v) => ({ ...v }));
}

// How many parts (charts) and members reference each section, keyed by id. A
// section a chart still calls for cannot be deleted; member links cascade.
export function voicePartUsage(): Record<
    string,
    { parts: number; members: number }
> {
    const out: Record<string, { parts: number; members: number }> = {};
    for (const v of voiceParts) out[v.id] = { parts: 0, members: 0 };
    for (const p of parts) {
        if (p.voicePartId && out[p.voicePartId]) out[p.voicePartId]!.parts += 1;
    }
    for (const m of members) {
        for (const s of m.sections) {
            if (out[s.voicePartId]) out[s.voicePartId]!.members += 1;
        }
    }
    return out;
}

export interface VoicePartInput {
    label: string;
    isPitched: boolean;
    nominalLowMidi: number | null;
    nominalHighMidi: number | null;
}

export type VoicePartWriteResult =
    | { ok: true; voicePart: VoicePartRow }
    | { ok: false; reason: "duplicate" | "not-found" };

const labelTaken = (label: string, exceptId?: string): boolean =>
    voiceParts.some(
        (v) =>
            v.id !== exceptId && v.label.toLowerCase() === label.toLowerCase(),
    );

export function createVoicePart(input: VoicePartInput): VoicePartWriteResult {
    if (labelTaken(input.label)) return { ok: false, reason: "duplicate" };
    const sortOrder =
        voiceParts.reduce((max, v) => Math.max(max, v.sortOrder), -1) + 1;
    const row: VoicePartRow = {
        id: newId("vp"),
        label: input.label,
        sortOrder,
        isPitched: input.isPitched,
        nominalLowMidi: input.nominalLowMidi,
        nominalHighMidi: input.nominalHighMidi,
    };
    voiceParts.push(row);
    return { ok: true, voicePart: { ...row } };
}

export function updateVoicePart(
    id: string,
    input: VoicePartInput,
): VoicePartWriteResult {
    const row = voiceParts.find((v) => v.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    if (labelTaken(input.label, id)) return { ok: false, reason: "duplicate" };
    row.label = input.label;
    row.isPitched = input.isPitched;
    row.nominalLowMidi = input.nominalLowMidi;
    row.nominalHighMidi = input.nominalHighMidi;
    return { ok: true, voicePart: { ...row } };
}

export type VoicePartDeleteResult =
    | { ok: true; removedMemberships: number }
    | { ok: false; reason: "not-found" }
    | { ok: false; reason: "in-use"; partCount: number };

// Mirror the schema: a section a chart still calls for (a part references it) is
// refused (part.voice_part_id is ON DELETE NO ACTION); member links cascade away
// (member_voice_part is ON DELETE CASCADE), so report how many were dropped.
export function deleteVoicePart(id: string): VoicePartDeleteResult {
    const row = voiceParts.find((v) => v.id === id);
    if (!row) return { ok: false, reason: "not-found" };
    const partCount = parts.filter((p) => p.voicePartId === id).length;
    if (partCount > 0) return { ok: false, reason: "in-use", partCount };
    let removedMemberships = 0;
    for (const m of members) {
        const before = m.sections.length;
        m.sections = m.sections.filter((s) => s.voicePartId !== id);
        removedMemberships += before - m.sections.length;
    }
    voiceParts.splice(voiceParts.indexOf(row), 1);
    return { ok: true, removedMemberships };
}

// Reassign sortOrder over the WHOLE vocabulary so the keys stay unique and
// gap-free no matter what the caller sends: take the supplied ids that exist
// (deduped, in order), then append any sections the list omitted (in their
// current order). A partial or dirty list can never collide two sections onto
// one sortOrder this way.
export function reorderVoiceParts(orderedIds: string[]): void {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of orderedIds) {
        if (!seen.has(id) && voiceParts.some((v) => v.id === id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    const remaining = [...voiceParts]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((v) => v.id)
        .filter((id) => !seen.has(id));
    [...ordered, ...remaining].forEach((id, i) => {
        const row = voiceParts.find((v) => v.id === id);
        if (row) row.sortOrder = i;
    });
}

// ---------------------------------------------------------------------------
// Writes (songs + parts)
// ---------------------------------------------------------------------------

export interface PartInput {
    id?: string; // present for an existing part, absent for a new one
    label: string;
    isRequired: boolean;
    countNeeded: number;
    voicePartId: string | null; // section id, or null for a solo
    isSolo: boolean;
    rangeLowMidi: number | null;
    rangeHighMidi: number | null;
}
export interface SongInput {
    // lastRehearsed is carried as a sibling field (like arranger/startPitch), not in
    // `song`: it is director-edited on the form, not a drafter-shaped core value set
    // here. It still round-trips onto the core Song via the SongRow.
    song: Omit<Song, "id" | "lastPerformed" | "lastRehearsed">;
    arranger: string | null;
    chartRef: string | null;
    lastRehearsed: string | null;
    startPitch: string | null;
    parts: PartInput[];
}

const newId = (prefix: string): string =>
    `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function writeParts(songId: string, input: PartInput[]): void {
    // Everything here is scoped to THIS song. A part id is honored only if it names
    // an existing part of this song; a foreign, stale, or duplicate id is treated as
    // a new part rather than touching another song's row or being silently dropped.
    const existing = parts.filter((p) => p.songId === songId);
    const existingById = new Map(existing.map((p) => [p.id, p]));
    const keptIds = new Set(
        input
            .map((p) => p.id)
            .filter((id): id is string => !!id && existingById.has(id)),
    );

    // Remove this song's parts the editor dropped, and prune their castings.
    for (const p of existing) {
        if (!keptIds.has(p.id)) {
            const idx = parts.indexOf(p);
            if (idx >= 0) parts.splice(idx, 1);
            for (let i = castings.length - 1; i >= 0; i--) {
                if (castings[i]!.partId === p.id) castings.splice(i, 1);
            }
        }
    }

    // Update kept parts in place (preserving id, so casting survives); add the rest
    // as new. An id seen twice updates once, then the duplicate becomes a new part.
    // sort_order comes from the input index, so the editor's array order is what sticks
    // (mirrors save_song's `with ordinality`).
    const seen = new Set<string>();
    input.forEach((pin, i) => {
        const row =
            pin.id && !seen.has(pin.id) ? existingById.get(pin.id) : undefined;
        if (row) {
            seen.add(pin.id!);
            row.label = pin.label;
            row.isRequired = pin.isRequired;
            row.countNeeded = pin.countNeeded;
            row.voicePartId = pin.voicePartId;
            row.isSolo = pin.isSolo;
            row.rangeLowMidi = pin.rangeLowMidi;
            row.rangeHighMidi = pin.rangeHighMidi;
            row.sortOrder = i;
        } else {
            parts.push({
                id: newId(`${songId}-p`),
                songId,
                label: pin.label,
                isRequired: pin.isRequired,
                countNeeded: pin.countNeeded,
                voicePartId: pin.voicePartId,
                isSolo: pin.isSolo,
                rangeLowMidi: pin.rangeLowMidi,
                rangeHighMidi: pin.rangeHighMidi,
                sortOrder: i,
            });
        }
    });
}

export function createSong(input: SongInput): SongRow {
    const id = newId("song");
    const row: SongRow = {
        ...input.song,
        id,
        publicId: id,
        lastPerformed: null,
        status: "active",
        arranger: input.arranger,
        chartRef: input.chartRef,
        lastRehearsed: input.lastRehearsed,
        startPitch: input.startPitch,
    };
    songs.push(row);
    writeParts(id, input.parts);
    return { ...row };
}

export function updateSong(
    id: string,
    input: SongInput,
    expectedVersion: string,
): WriteResult {
    const row = songs.find((s) => s.id === id);
    if (!row) return { ok: false, reason: "not_found" };
    if (ver(id) !== expectedVersion) return { ok: false, reason: "conflict" };
    Object.assign(row, input.song); // id, lastPerformed, lastRehearsed, status are not in SongInput.song
    row.arranger = input.arranger;
    row.chartRef = input.chartRef;
    row.lastRehearsed = input.lastRehearsed;
    row.startPitch = input.startPitch;
    writeParts(id, input.parts);
    return { ok: true, version: bumpVersion(id) };
}

export function setSongStatus(
    id: string,
    status: SongStatus,
): SongRow | undefined {
    const row = songs.find((s) => s.id === id);
    if (!row) return undefined;
    row.status = status;
    return { ...row };
}

/** Replace all castings for a song's parts. Scoped to the song; the caller has
 *  already validated part/member ids and the one-primary-per-part rule. */
export function setSongCasting(
    songId: string,
    next: CastingWrite[],
    expectedVersion: string,
): WriteResult {
    const song = songs.find((s) => s.id === songId);
    if (!song) return { ok: false, reason: "not_found" };
    if (ver(songId) !== expectedVersion)
        return { ok: false, reason: "conflict" };
    const partIds = new Set(
        parts.filter((p) => p.songId === songId).map((p) => p.id),
    );
    // Derive learned_at: keep the original date while a cover stays solid, stamp today
    // when it newly becomes solid, clear it otherwise (null while not solid). Persisted
    // for a future "recently learned" view; nothing displays it yet.
    const prior = new Map(
        castings
            .filter((c) => partIds.has(c.partId))
            .map((c) => [`${c.partId}:${c.memberId}`, c]),
    );
    for (let i = castings.length - 1; i >= 0; i--) {
        if (partIds.has(castings[i]!.partId)) castings.splice(i, 1);
    }
    const today = todayInEnsembleTz();
    for (const c of next) {
        if (!partIds.has(c.partId)) continue;
        const was = prior.get(`${c.partId}:${c.memberId}`);
        const learnedAt =
            c.directorAssessed === "solid"
                ? was?.directorAssessed === "solid"
                    ? (was.learnedAt ?? today)
                    : today
                : null;
        castings.push({ ...c, learnedAt });
    }
    return { ok: true, version: bumpVersion(songId) };
}

// ---------------------------------------------------------------------------
// Playground: standalone, staffing-independent programs
// ---------------------------------------------------------------------------
//
// A playground program is a hand-built setlist that does NOT pass through an event
// or the feasibility funnel. The director picks songs and arranges them with the
// sequencer and seam logic alone, for fixed programs (a pre-identified concert).
// Saved for reuse, reachable from its own menu, and linkable to an event later
// (seeded as that setlist's pins) to check coverage against who is available.
//
// Maps to the schema's program (+ program_item) tables; the songIds/open/close here
// are the hydrated projection of program_item rows (position + the 'open'/'close'
// pin). Assignment to an event is recorded on the setlist (setlist.program_id).

export interface PlaygroundMeta {
    id: string;
    // The URL token for this program. Never replaces id (the uuid).
    publicId: string;
    name: string;
    songIds: string[]; // ordered; the arrangement itself
    open: string | null; // opener anchor the auto-arrange honors
    close: string | null; // closer anchor
}

const playgrounds = new Map<string, PlaygroundMeta>([
    [
        "pg-spring",
        {
            id: "pg-spring",
            publicId: "pg-spring",
            name: "Spring concert",
            songIds: ["stand", "lean", "mountain", "higher", "shout"],
            open: "stand",
            close: "shout",
        },
    ],
]);

const clonePlayground = (p: PlaygroundMeta): PlaygroundMeta => ({
    ...p,
    songIds: [...p.songIds],
});

export function listPlaygrounds(): PlaygroundMeta[] {
    return [...playgrounds.values()].map(clonePlayground);
}

export function getPlayground(id: string): PlaygroundMeta | undefined {
    const p = playgrounds.get(id);
    return p ? clonePlayground(p) : undefined;
}

export function createPlayground(name: string): PlaygroundMeta {
    const id = newId("pg");
    const row: PlaygroundMeta = {
        id,
        publicId: id,
        name,
        songIds: [],
        open: null,
        close: null,
    };
    playgrounds.set(id, row);
    return clonePlayground(row);
}

export function updatePlayground(
    id: string,
    patch: {
        name?: string;
        songIds?: string[];
        open?: string | null;
        close?: string | null;
    },
): PlaygroundMeta | undefined {
    const row = playgrounds.get(id);
    if (!row) return undefined;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.songIds !== undefined) row.songIds = [...patch.songIds];
    if (patch.open !== undefined) row.open = patch.open;
    if (patch.close !== undefined) row.close = patch.close;
    // Keep anchors consistent however the patch arrived: an anchor must be one of the
    // program's songs, and one song cannot hold both ends.
    if (row.open !== null && !row.songIds.includes(row.open)) row.open = null;
    if (
        row.close !== null &&
        (!row.songIds.includes(row.close) || row.close === row.open)
    )
        row.close = null;
    return clonePlayground(row);
}

// A program is "assigned" once it has been instantiated into an event setlist,
// which carries its id. Mirrors the schema's setlist.program_id reference.
export function isPlaygroundAssigned(id: string): boolean {
    return [...setlists.values()].some((s) => s.programId === id);
}

export type PlaygroundDeleteResult =
    | { ok: true }
    | { ok: false; reason: "not-found" | "assigned" };

// A program can be deleted only while it has not been assigned to an event. Mirrors
// the schema's on-delete-restrict on setlist.program_id.
export function deletePlayground(id: string): PlaygroundDeleteResult {
    if (!playgrounds.has(id)) return { ok: false, reason: "not-found" };
    if (isPlaygroundAssigned(id)) return { ok: false, reason: "assigned" };
    playgrounds.delete(id);
    return { ok: true };
}

// Seed an event setlist from a saved program: the ends become open/close, the rest
// are kept, so the event draft honors the program and surfaces any coverage gap. The
// new setlist records programId, which assigns the program (blocking its deletion).
// Returns the new setlist, or undefined if the program or event is missing.
export function createSetlistFromPlayground(
    playgroundId: string,
    eventId: string,
): SetlistMeta | undefined {
    const pg = playgrounds.get(playgroundId);
    if (!pg) return undefined;
    const meta = createSetlist(eventId, pg.name, playgroundId);
    if (!meta) return undefined; // event not found
    const open = pg.open;
    const close = pg.close && pg.close !== open ? pg.close : null;
    const keep = pg.songIds.filter((sid) => sid !== open && sid !== close);
    setPins(meta.id, { open, close, keep, excluded: [] });
    return meta;
}

// --- Public id resolution -------------------------------------------------

// The routable entities that carry a URL token. The ensemble token is resolved a layer up
// (the proxy / getRepositoryFor), so it is not here; these are the inner rows a page resolves
// from its /e/:ensemble/... token segments.
export type PublicIdEntity =
    | "song"
    | "member"
    | "event"
    | "setlist"
    | "program";

// Resolve a public_id token to the internal uuid, or null when no such row exists. The mock has
// no separate token, so the id doubles as the public_id: this verifies the row exists and hands
// back its id. The Supabase adapter does the real point lookup (public_id -> id), RLS-scoped.
export function resolvePublicId(
    entity: PublicIdEntity,
    publicId: string,
): string | null {
    switch (entity) {
        case "song":
            return songs.some((s) => s.id === publicId) ? publicId : null;
        case "member":
            return members.some((m) => m.id === publicId) ? publicId : null;
        case "event":
            return events.some((e) => e.id === publicId) ? publicId : null;
        case "setlist":
            return setlists.has(publicId) ? publicId : null;
        case "program":
            return playgrounds.has(publicId) ? publicId : null;
    }
}
