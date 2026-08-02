// The shapes at the transport boundary. They reuse the core domain types, so
// there is no translation layer between the hydration JSON and the drafter.

import type {
    Availability,
    Casting,
    DraftWithChase,
    ID,
    Member,
    Part,
    ResolvedEvent,
    Seam,
    SetBreak,
    Song,
} from "@repertoire/core";

/**
 * The JSON document hydrate_draft_input returns. It is the domain arrays the
 * funnel reads, plus the three tag lists the mapper folds into options.context.
 * The raw document can carry a null event (not found or not visible); the
 * endpoint guards that before treating it as a HydrationPayload.
 */
export interface HydrationPayload {
    event: ResolvedEvent;
    members: Member[];
    availability: Availability[];
    songs: Song[];
    parts: Part[];
    castings: Casting[];
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}

/**
 * The injected data dependency. Implement it over a Supabase client, or fake it
 * in tests. It returns the raw JSON document, which may be null or carry a null
 * event when the event is not found or not visible.
 */
export interface HydrationSource {
    hydrate(eventId: ID): Promise<unknown>;
}

/**
 * The pins for one setlist, from hydrate_setlist_locks. eventId is null when the
 * setlist is not found or not visible. opens and closes are arrays because the
 * schema allows pinning more than one; the endpoint guards the cardinality.
 */
export interface SetlistLocks {
    eventId: ID | null;
    opens: ID[];
    closes: ID[];
    keep: ID[];
    excluded: ID[];
    // Per-song transition overrides (segues): the gap, in seconds, LEAVING each song.
    // Absent for a song = the event's per-song padding (0 = attacca).
    transitions: { songId: ID; seconds: number }[];
    // Breaks (intermissions) placed at ordinal slots in this setlist. They reduce the
    // fill budget and split the order into independently-sequenced segments.
    breaks: SetBreak[];
}

export interface LocksSource {
    hydrateLocks(setlistId: ID): Promise<unknown>;
}

/** Drafting into a specific setlist needs both reads. */
export type SetlistSource = HydrationSource & LocksSource;

export type DraftSetResponse =
    | { status: 200; body: DraftWithChase }
    | { status: 404; body: { error: string } }
    | { status: 422; body: { error: string } };

/**
 * Seam diagnostics for a manual order. The drafter re-sequences each draft, so a
 * director's hand-arrangement is re-costed here without re-drafting: send the
 * order, get the seams and the padded total back.
 */
export type SeamsResponse =
    | { status: 200; body: { seams: Seam[]; totalSeconds: number } }
    | { status: 404; body: { error: string } };

/**
 * A re-sequence of the songs already in a set (auto-arrange): re-orders the current
 * songs honoring the opener/closer pins, without re-drafting, so nothing is swapped
 * in or out. Returns the new order with its seams and padded total.
 */
export type ArrangeResponse =
    | {
          status: 200;
          body: { order: ID[]; seams: Seam[]; totalSeconds: number };
      }
    | { status: 404; body: { error: string } };
