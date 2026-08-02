// The data-access boundary. Every route handler and server component reads and
// writes the app's data through this seam, never the in-memory db module directly.
// The mock adapter delegates to lib/db.ts; the Supabase adapter issues RLS-scoped
// queries against the live database from the signed-in user's client. getRepository()
// picks one by DATA_SOURCE — mirroring lib/source.ts, the parallel seam for the
// @repertoire/api draft / locks RPC contract.
//
// Every method is async even though the mock is synchronous. The Supabase adapter
// is network-backed, so callers must already await; that await is the whole point
// of the boundary — it is what lets the data source swap without touching a single
// route. getRepository() itself stays synchronous and parameterless: the Supabase
// adapter builds its per-request, RLS-scoped client lazily inside each method
// (from the request's session cookies), so the data source can swap without
// rippling the call sites a second time.

import { cache } from "react";
import { cookies } from "next/headers";
import { dataSource } from "./env";
import * as db from "./db";
import { ACTIVE_ENSEMBLE_COOKIE } from "./ensemble";
import { isPublicId } from "./publicId";
import { createSupabaseRepository } from "./supabase/repository";
import { dbError } from "./supabase/errors";
import { serverClient } from "./supabase/server";

// The mock's data-access surface, grouped by domain. The Repository type is DERIVED
// from this object (Promisified, below), so the published interface can never drift
// from what the mock actually provides — and the Supabase adapter is type-checked
// against the exact same shape. Type-only and constant exports (e.g. DEFAULT_PADDING)
// stay imported from ./db directly; this boundary is for reads and writes only.
const mockSurface = {
    // Ensemble settings (the tenant row)
    getEnsembleSettings: db.getEnsembleSettings,
    updateEnsembleSettings: db.updateEnsembleSettings,

    // Public id resolution: a URL token -> the internal uuid within the active ensemble
    resolvePublicId: db.resolvePublicId,

    // Events
    listEvents: db.listEvents,
    getEvent: db.getEvent,
    createEvent: db.createEvent,
    updateEvent: db.updateEvent,
    deleteEvent: db.deleteEvent,
    getEventSetlists: db.getEventSetlists,
    setAvailability: db.setAvailability,
    setMyAvailability: db.setMyAvailability,

    // Rehearsal agenda
    getRehearsalAgenda: db.getRehearsalAgenda,
    saveRehearsalAgenda: db.saveRehearsalAgenda,

    // Rehearsal record: stamp last_rehearsed + attendance
    markSongsRehearsed: db.markSongsRehearsed,
    getAttendance: db.getAttendance,
    saveAttendance: db.saveAttendance,

    // Prep targets: a gig's "have these ready" set
    getPrepTargets: db.getPrepTargets,
    savePrepTargets: db.savePrepTargets,
    togglePrepTarget: db.togglePrepTarget,

    // Setlists
    listEventSetlists: db.listEventSetlists,
    getSetlistMeta: db.getSetlistMeta,
    setlistLockReason: db.setlistLockReason,
    createSetlist: db.createSetlist,
    updateSetlist: db.updateSetlist,
    deleteSetlist: db.deleteSetlist,
    publishSetlist: db.publishSetlist,
    unpublishSetlist: db.unpublishSetlist,
    shareSetlistDraft: db.shareSetlistDraft,
    unshareSetlistDraft: db.unshareSetlistDraft,
    syncSharedDraftOrder: db.syncSharedDraftOrder,
    syncPublishedOrder: db.syncPublishedOrder,
    getSharedDraft: db.getSharedDraft,
    setPins: db.setPins,
    getArrangedOrder: db.getArrangedOrder,
    setArrangedOrder: db.setArrangedOrder,
    markPerformed: db.markPerformed,
    getPerformedSet: db.getPerformedSet,
    getPublishedSet: db.getPublishedSet,
    cloneSetlist: db.cloneSetlist,
    getSetlistHistory: db.getSetlistHistory,
    hydratePayload: db.hydratePayload,

    // Setlist items (per-item notes / segues / breaks)
    setItemNote: db.setItemNote,
    getItemNotes: db.getItemNotes,
    setTransition: db.setTransition,
    getTransitions: db.getTransitions,
    setBreaks: db.setBreaks,
    getBreaks: db.getBreaks,

    // Members
    listMembers: db.listMembers,
    listRoster: db.listRoster,
    getMember: db.getMember,
    createMember: db.createMember,
    updateMember: db.updateMember,
    setMemberStatus: db.setMemberStatus,
    inviteMember: db.inviteMember,
    updateMyProfile: db.updateMyProfile,

    // Songs + parts + casting
    listSongs: db.listSongs,
    getSong: db.getSong,
    getSongParts: db.getSongParts,
    getSongCasting: db.getSongCasting,
    getEnsembleCoverage: db.getEnsembleCoverage,
    listMyCastings: db.listMyCastings,
    listMyPartCoverage: db.listMyPartCoverage,
    setMyConfidence: db.setMyConfidence,
    createSong: db.createSong,
    updateSong: db.updateSong,
    setSongStatus: db.setSongStatus,
    setSongCasting: db.setSongCasting,

    // Tags
    listTags: db.listTags,
    tagUsage: db.tagUsage,
    createTag: db.createTag,
    updateTag: db.updateTag,
    deleteTag: db.deleteTag,
    reorderTags: db.reorderTags,

    // Voice parts
    listVoiceParts: db.listVoiceParts,
    voicePartUsage: db.voicePartUsage,
    createVoicePart: db.createVoicePart,
    updateVoicePart: db.updateVoicePart,
    deleteVoicePart: db.deleteVoicePart,
    reorderVoiceParts: db.reorderVoiceParts,

    // Padding profiles
    listPaddingProfiles: db.listPaddingProfiles,
    paddingProfileUsage: db.paddingProfileUsage,
    createPaddingProfile: db.createPaddingProfile,
    updatePaddingProfile: db.updatePaddingProfile,
    deletePaddingProfile: db.deletePaddingProfile,

    // Event types (templating presets)
    listEventTypes: db.listEventTypes,
    eventTypeUsage: db.eventTypeUsage,
    resolveEventTypePreset: db.resolveEventTypePreset,
    eventTypePresets: db.eventTypePresets,
    createEventType: db.createEventType,
    updateEventType: db.updateEventType,
    deleteEventType: db.deleteEventType,
    reorderEventTypes: db.reorderEventTypes,

    // Soloist history
    listSoloistAppearances: db.listSoloistAppearances,

    // Playgrounds
    listPlaygrounds: db.listPlaygrounds,
    getPlayground: db.getPlayground,
    createPlayground: db.createPlayground,
    updatePlayground: db.updatePlayground,
    isPlaygroundAssigned: db.isPlaygroundAssigned,
    deletePlayground: db.deletePlayground,
    createSetlistFromPlayground: db.createSetlistFromPlayground,
};

// Promisify every method's return type. Awaited<R> collapses to R for the mock's
// synchronous returns; the Supabase adapter implements the very same async shape.
type Promisified<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? (...args: A) => Promise<Awaited<R>>
        : never;
};

/**
 * The data-access contract shared by the mock and Supabase adapters. Derived from
 * the mock surface, so it always matches the functions the mock exposes.
 */
export type Repository = Promisified<typeof mockSurface>;

// The mock adapter: each method delegates to the synchronous in-memory db and
// resolves immediately. Wrapping in an async function (rather than returning the
// raw value) is what gives every method the Promise return the interface demands.
function promisify<T extends Record<string, (...args: never[]) => unknown>>(
    surface: T,
): Promisified<T> {
    const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const key of Object.keys(surface)) {
        const fn = surface[key] as unknown as (...args: unknown[]) => unknown;
        out[key] = async (...args: unknown[]) => fn(...args);
    }
    return out as Promisified<T>;
}

const mockRepository: Repository = promisify(mockSurface);

// The Supabase adapter. The adapter instance is memoized PER REQUEST via React's
// cache(): one client + one createSupabaseRepository per request, so the adapter's
// internal _ensemble/_me caches hold for the whole page render instead of resetting
// on every method call (each reset cost a getUser round trip plus a membership
// query before the real work). The Proxy keeps getRepository() synchronous — the
// request context is still read lazily, at first method call.
const requestSupabaseRepository = cache(async () => {
    const [client, jar] = await Promise.all([serverClient(), cookies()]);
    const ensemble = jar.get(ACTIVE_ENSEMBLE_COOKIE)?.value;
    return createSupabaseRepository(client, ensemble);
});

const supabaseRepository: Repository = new Proxy({} as Repository, {
    get(_target, prop) {
        return async (...args: unknown[]) => {
            const repo = await requestSupabaseRepository();
            const method = repo[prop as keyof Repository] as (
                ...a: unknown[]
            ) => Promise<unknown>;
            return method(...args);
        };
    },
});

/**
 * The one place the data source is chosen for the CRUD/read surface. Mirrors
 * getSource() in lib/source.ts (which covers the @repertoire/api RPC contract).
 *
 * Used by server PAGES, which sit under /e/:ensembleId and whose active-ensemble
 * cookie the proxy keeps synced to that URL. API route handlers must NOT use this —
 * the shared cookie can lag a tab, so a write could target the wrong ensemble.
 * Routes resolve the ensemble from their own /api/e/:ensembleId URL via
 * getRepositoryFor() instead.
 */
export function getRepository(): Repository {
    return dataSource === "supabase" ? supabaseRepository : mockRepository;
}

// A path segment bound to a uuid column: a non-uuid would raise Postgres 22P02 in the queries
// below and surface as a 500, so reject it as a clean 404 (it can never name a real row) first.
// Exported so the route handlers can guard their own inner path segments (badPathUuid).
export const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A caller is not an active member of the ensemble it asked to act in. */
export class RepositoryAccessError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "RepositoryAccessError";
    }
}

/**
 * The data-access seam for /api/e/:ensemble route handlers. The ensemble comes from the URL
 * (a public_id token), not the shared cookie, so a stale tab can never make a write land in the
 * wrong ensemble. Resolves the token to the internal uuid and validates that the signed-in user
 * is an active member of that ensemble (throws RepositoryAccessError -> 401/403/404 otherwise),
 * then returns an adapter scoped to the resolved uuid. In mock mode tenancy is moot, so the mock
 * is returned. Inner API path segments (event / setlist ids) stay uuids; badPathUuid still guards
 * them, so UUID_RE stays exported below.
 */
export async function getRepositoryFor(
    ensembleToken: string,
    opts?: { requireDirector?: boolean },
): Promise<Repository> {
    if (dataSource !== "supabase") return mockRepository;
    const client = await serverClient();
    const {
        data: { user },
    } = await client.auth.getUser();
    if (!user) throw new RepositoryAccessError(401, "not authenticated");
    // The /api/e/:ensemble segment is a public_id token; a malformed one can never name a row.
    if (!isPublicId(ensembleToken))
        throw new RepositoryAccessError(404, "ensemble not found");
    // Resolve the token to the internal uuid in the SAME membership query. !inner makes the
    // public_id filter restrict the member rows to the matching ensemble (a left embed would keep
    // every membership and null the non-matching embed). The member row is self-readable even in an
    // archived ensemble, but the embedded ensemble is only visible when ensemble_read passes (an
    // active tenant), so a null embed means archived/suspended — 403, mirroring the proxy's bounce.
    const { data: membership, error } = await client
        .from("member")
        .select(
            "id, permission_tier, ensemble:ensemble_id!inner(id, public_id)",
        )
        .eq("user_id", user.id)
        .eq("ensemble.public_id", ensembleToken)
        .eq("status", "active")
        .maybeSingle();
    if (error) throw dbError(error);
    // PostgREST returns a to-one embed as an object, but the untyped client can widen it to an
    // array; normalize before reading the resolved uuid.
    const ensemble = (
        Array.isArray(membership?.ensemble)
            ? membership?.ensemble[0]
            : membership?.ensemble
    ) as { id: string } | null | undefined;
    if (!membership || !ensemble)
        throw new RepositoryAccessError(403, "ensemble access denied");
    // A second gate over RLS for director-only routes: without it a member's denied
    // write surfaces as a PostgREST error (a 500), not a clean 403 — and authorization
    // would rest on every table's write policy alone.
    if (opts?.requireDirector && membership.permission_tier !== "director") {
        throw new RepositoryAccessError(403, "director only");
    }
    // Scope the adapter to the resolved uuid; the token never travels below the routing layer.
    return createSupabaseRepository(client, ensemble.id);
}
