// Domain model, schema-shaped. The drafter reads these.
//
// These match the schema in supabase/migrations/ with no translation layer. No provenance (the drafter
// never reasons about created_by or updated_at), no ensemble_id (tenancy is
// enforced at the hydration boundary, so the core stays tenant-agnostic).

export type ID = string;
export type MidiPitch = number; // middle C = 60

export interface KeySig {
    fifths: number; // -7..7
    mode: "major" | "minor";
}

export type AssessedReadiness =
    | "performance-ready"
    | "needs-polish"
    | "learning"
    | "dormant";
export type BookStatus = "off-book" | "on-book";
export type Confidence = "solid" | "shaky" | "learning";
export type AvailabilityStatus = "in" | "out" | "tentative";

// Tags carry a category so the sequencer knows what to do with each: mood,
// groove, and genre diversify adjacency, content gates appropriateness, occasion
// is ignored for adjacency. null = uncategorized, no signal.
export type TagCategory = "mood" | "groove" | "genre" | "occasion" | "content";

export interface Tag {
    name: string;
    category: TagCategory | null;
}

// Carried for the API and future range-aware casting. No current stage reads it.
export interface Member {
    id: ID;
    displayName: string;
}

export interface Song {
    id: ID;
    title: string;
    startKey: KeySig | null;
    endKey: KeySig | null; // where it lands if it modulates; null = ends as it started
    startTempoBpm: number | null;
    endTempoBpm: number | null; // closing tempo if it changes; null = constant
    durationSeconds: number | null;
    isExplicit: boolean; // policy field, gated by event.allowsExplicit
    usesAccompaniment: boolean; // policy field, gated by event.allowsAccompaniment; false = a cappella
    intensity: number | null; // director-rated felt energy 1..5, by peak impact; null = unrated
    tags: Tag[]; // categorized; steering and adjacency variety, explicit is not in here
    assessedReadiness: AssessedReadiness;
    bookStatus: BookStatus;
    lastPerformed: string | null; // ISO date
    lastRehearsed: string | null; // ISO date; drives the staleness ("gone cold") nudge
}
// Start and end are both load-bearing. The transition cost between adjacent
// songs reads the END of song N against the START of song N+1, for key and
// tempo. A chart that modulates launches the next song from where it landed,
// not where it opened. The cost function is keyTransitionCost in drafter/sequence.ts.

export interface Part {
    id: ID;
    songId: ID;
    isRequired: boolean;
    countNeeded: number;
    label: string; // resolved in SQL: part.label, else the section name, else 'Solo'
}
// voicePartId, isSolo, and range are not read by any stage, because castings
// encode coverage. They stay out of the core type.

export interface Casting {
    partId: ID;
    memberId: ID;
    isPrimary: boolean;
    confidence: Confidence | null; // the member's self-report; null = unreported, distinct from solid
    // The director's own read of this cover, distinct from the member's self-report.
    // readiness prefers it over the self-report when set, else falls back to it.
    // Null = the director has formed no read (or the viewer is not a director, since
    // casting_visible exposes it only to directors), so it carries no strike.
    directorAssessed: Confidence | null;
}

export interface Availability {
    memberId: ID;
    status: AvailabilityStatus; // already scoped to the one event by the query
}

export interface PaddingProfile {
    perSongSeconds: number;
    perSetSeconds: number; // one-time overhead, native now
}

export interface ResolvedEvent {
    id: ID;
    eventDate: string | null;
    targetDurationSeconds: number | null; // the soft goal: the fill leans under it, warns when short
    maxDurationSeconds: number | null; // hard ceiling: the set must never exceed it (competition slot)
    allowsOnBook: boolean;
    allowsExplicit: boolean;
    allowsAccompaniment: boolean;
    padding: PaddingProfile;
}

export interface ContextPolicy {
    excludeTags: string[];
    preferTags: string[];
    // Set-level mandate: the drafted set must contain at least one song carrying each
    // of these tags (a competition rule, e.g. one original arrangement). Unlike exclude
    // (drops a song) and prefer (nudges a song), require never gates a song; it forces
    // representation in the finished set, and names the lever when the pool cannot.
    requireTags: string[];
}

// Optional selection entropy. Off by default: with no variety the draft is the
// deterministic optimum. When set, each qualified song's score is nudged by a
// seeded, per-song amount before the fill, so a fresh seed offers a different but
// still-valid set. It never touches the hard gates or the target; it only changes
// which ready, coverable, appropriate songs get pulled. amount 0 is a no-op.
export interface VarietyConfig {
    seed: number;
    amount: number; // 0 = deterministic; larger shuffles harder (roughly score units)
}

export interface DraftOptions {
    readinessFloor?: AssessedReadiness[];
    countTentativeAsAvailable?: boolean; // default false
    open?: ID; // pin to the start
    close?: ID; // pin to the end
    keep?: ID[]; // forced in, position flexible (the schema's 'keep')
    // Preferred, not forced. A prep commitment: bypasses the soft gates (readiness, context)
    // like a keep, but still respects the hard limits — an uncastable or over-budget preferred
    // song benches instead of forcing the set over. Picked before non-preferred songs.
    prefer?: ID[];
    excluded?: ID[];
    context?: ContextPolicy;
    variety?: VarietyConfig; // off by default; the deterministic draft sets none
}

export const DEFAULT_READINESS_FLOOR: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
];

// A break in the running order — an intermission or extended patter spot. It holds
// time on the clock but takes no stage slot, and it splits the set into segments the
// sequencer treats independently (a hard flow-reset: the ear resets across a break,
// so an adjacent key clash there does not matter and each segment builds its own arc).
// Ordinal: it sits AFTER the k-th song (afterPosition, 1..N-1 of the final song order),
// not anchored to a specific song — an intermission is a structural slot, not a segue.
export interface SetBreak {
    id: ID;
    label: string;
    durationSeconds: number;
    afterPosition: number;
}

export interface DraftInput {
    songs: Song[];
    parts: Part[];
    castings: Casting[];
    availability: Availability[];
    event: ResolvedEvent;
    members?: Member[]; // optional; not read by the funnel yet
    // Per-song transition overrides (segues), keyed by the song the gap LEAVES, in
    // seconds. Absent for a song = the event's per-song padding. Feeds the sequencer's
    // key-clash decay and the running-order clock; empty/omitted = uniform gaps (the
    // auto-draft has no segues until the director sets them on a concrete order).
    transitionOut?: Record<ID, number>;
    // Breaks (intermissions) placed at ordinal slots. They reduce the song fill budget
    // (the set sizes around them) and split the order into independently-sequenced
    // segments. Empty/omitted = one continuous set, today's behavior.
    breaks?: SetBreak[];
    options?: DraftOptions;
}
