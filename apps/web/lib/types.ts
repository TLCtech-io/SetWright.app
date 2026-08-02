// View shapes the setlist page and its routes pass to the client. The draft
// itself stays a pure @repertoire/core DraftWithChase; these only bundle it with
// the current pins and a song catalog the client needs for labels and restores.

import type { DraftWithChase, SetBreak } from "@repertoire/core";

// The director's pins for one setlist. Opener and closer are single songs (the
// ends take one each); keep forces a song in, excluded bars it.
export interface PinState {
    open: string | null;
    close: string | null;
    keep: string[];
    excluded: string[];
}

export const EMPTY_PINS: PinState = {
    open: null,
    close: null,
    keep: [],
    excluded: [],
};

export interface SetlistDraftPayload {
    setlistId: string;
    eventId: string;
    draft: DraftWithChase;
    pins: PinState;
    // id is the song uuid (the join key the drafter and API use); publicId is its URL token, so the
    // print sheet can map an ?order= param of tokens back to uuids. meta is a short label line.
    catalog: {
        id: string;
        publicId: string;
        title: string;
        meta: string | null;
    }[];
    notes: Record<string, string>; // per-song annotations, keyed by songId
    transitions: Record<string, number>; // per-song segue overrides (gap leaving the song), keyed by songId
    breaks: SetBreak[]; // breaks (intermissions) at ordinal slots
    // Set songs the event's confirmed participants can't cover, keyed by songId to the short part
    // labels. Only pinned songs land here: a hard pin skips the drafter's feasibility gate, so an
    // uncastable pinned song sits in the set and needs an explicit flag. Empty/absent = castable.
    castShort: Record<string, string[]>;
    prepIds: string[]; // the gig's current prep targets, so the editor can toggle per-song membership
    // Committed prep songs the draft could not place. Prep is preferred, not forced, so an
    // uncastable or over-budget commitment benches; these surface it so the director can act.
    unplacedPrep: UnplacedPrep[];
}

// A prep commitment that did not make the draft, and why. 'cast' = the confirmed participants
// can't cover it (shortParts names the gaps); 'room' = it did not fit the night's budget;
// 'data' = it has no chart length to place.
export interface UnplacedPrep {
    songId: string;
    title: string;
    reason: "cast" | "room" | "data";
    shortParts?: string[];
}
