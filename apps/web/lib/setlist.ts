// Server-side assembly of a setlist's full view: the draft (honoring pins), the
// current pins, and a song catalog for labels and restores. Used by the setlist
// route's GET and POST.
//
// The returned pins are reconciled to the same rules the drafter applies
// (resolveForced): close drops when it equals open, keep is deduped against the
// ends, and any id not in the event pool is dropped. So the badges the client
// shows always match the set the draft actually produced, even for a pin state
// written directly rather than through the UI's own handlers.
//
// Note: for the mock this reads through the source more than once (locks for the
// pins, the draft, the pool for the catalog), and draftSetForSetlist re-reads
// locks internally. That is free and consistent against the in-memory fixtures.
// Under Supabase those become separate, untransacted RPCs, so a pin write landing
// between the two locks reads could return pins from a different snapshot than the
// draft honored. Consolidate then: read locks once and thread them into the draft
// path (or one RPC returning locks + pool + draft input together).

import { draftSetForSetlist } from "@repertoire/api";
import type { HydrationPayload } from "@repertoire/api";
import {
    breaksOf,
    checkFeasibility,
    clockSeconds,
    indexByPart,
    indexBySong,
    interleaveBreaks,
    songsOf,
} from "@repertoire/core";
import type { DraftWithChase, SongItem, VarietyConfig } from "@repertoire/core";
import { getSource } from "./source";
import type { Repository } from "@/lib/repository";
import { EMPTY_PINS } from "./types";
import type { PinState, SetlistDraftPayload } from "./types";
import { songMeta } from "@/lib/format";

interface RawLocks {
    eventId: string | null;
    opens: string[];
    closes: string[];
    keep: string[];
    excluded: string[];
}

export type LoadResult =
    | { status: 200; body: SetlistDraftPayload }
    | { status: 404; body: { error: string } }
    | { status: 422; body: { error: string } };

// Mirror core's resolveForced plus pool membership, so the pins echoed to the
// client are the pins the draft honored.
function reconcilePins(locks: RawLocks, ids: Set<string>): PinState {
    const inPool = (id: string | undefined): id is string =>
        id !== undefined && ids.has(id);
    const open = inPool(locks.opens[0]) ? locks.opens[0]! : null;
    const rawClose = inPool(locks.closes[0]) ? locks.closes[0]! : null;
    const close = rawClose === open ? null : rawClose; // open wins both ends
    const keep = [
        ...new Set(
            (locks.keep ?? []).filter(
                (id) => ids.has(id) && id !== open && id !== close,
            ),
        ),
    ];
    const excluded = [
        ...new Set((locks.excluded ?? []).filter((id) => ids.has(id))),
    ];
    return { open, close, keep, excluded };
}

export async function loadSetlist(
    repo: Repository,
    setlistId: string,
    variety?: VarietyConfig,
): Promise<LoadResult> {
    // `repo` must be scoped to the SAME ensemble as the request (the URL's ensemble for an API
    // route, the proxy-synced cookie for a server page). loadSetlist reads getPerformedSet /
    // getItemNotes / getTransitions through it, so passing a cookie-scoped repo on an /api/e/:id
    // route would mis-scope those reads to a stale tab's ensemble.
    //
    // Prove the setlist belongs to that ensemble before hydrating. getSource() below is only
    // RLS-scoped, which authorizes a multi-ensemble user across ALL their ensembles, so without
    // this a tenant-B setlist could be loaded under a tenant-A URL. getSetlistMeta is
    // ensemble-scoped (mirrors the draft route's getEvent guard), so a mismatch returns undefined.
    if (!(await repo.getSetlistMeta(setlistId))) {
        return {
            status: 404,
            body: { error: "setlist not found or not visible" },
        };
    }
    // A performed set is an immutable record: return its frozen order, not a re-draft,
    // so every reader of this boundary sees the recorded set. Under Supabase the
    // frozen order comes from setlist_item; here from the mock.
    const performed = await repo.getPerformedSet(setlistId);
    if (performed) {
        const songItems: SongItem[] = performed.songs.map((s) => ({
            kind: "song",
            song: s,
            stage: s.durationSeconds ?? 0,
        }));
        const set = interleaveBreaks(songItems, performed.breaks);
        // The frozen running-order clock: durations + segues + breaks + per-set overhead.
        const totalSeconds = clockSeconds(
            performed.songs,
            performed.padding,
            new Map(Object.entries(performed.transitions)),
            performed.breaks,
        );
        const draft: DraftWithChase = {
            set,
            bench: [],
            totalSeconds,
            targetSeconds: null,
            seams: [],
            sequenceCost: 0,
            shortfall: null,
            drops: [],
            chase: [],
        };
        return {
            status: 200,
            body: {
                setlistId,
                eventId: performed.eventId,
                draft,
                pins: EMPTY_PINS,
                catalog: performed.songs.map((s) => ({
                    id: s.id,
                    publicId: s.publicId ?? s.id,
                    title: s.title,
                    meta: songMeta(s),
                })),
                notes: performed.notes,
                transitions: performed.transitions,
                breaks: performed.breaks,
                castShort: {}, // a performed set is a frozen record; no live cast check
                prepIds: [], // prep is a planning tool; a performed set is done, so none apply
                unplacedPrep: [], // a performed set is done; nothing left to place
            },
        };
    }

    const source = getSource();

    const locks = (await source.hydrateLocks(setlistId)) as RawLocks;
    if (!locks || locks.eventId === null) {
        return {
            status: 404,
            body: { error: "setlist not found or not visible" },
        };
    }
    const eventId = locks.eventId;

    // The gig's prep targets feed the draft as PREFERRED songs: the director's commitments are
    // strongly favored into the set past the soft gates, but not forced. An uncastable or
    // over-budget commitment benches, and is surfaced below (unplacedPrep) rather than distorting
    // the set.
    const prepIds = await repo.getPrepTargets(eventId);

    // variety (when set) is applied to the re-draft; the first load passes none, so
    // the canonical draft stays deterministic.
    //
    // The director's persisted manual arrangement (drag / Auto-arrange) overrides the drafter's order
    // (reconciled to the drafted set), so the editor, publish, and share all show what the director
    // arranged. Skipped when regenerating (variety set): a fresh reroll wants a fresh order — and the
    // redraft route clears the arrangement anyway.
    const arrangedOrder = variety
        ? null
        : await repo.getArrangedOrder(setlistId);
    const draftRes = await draftSetForSetlist(
        source,
        setlistId,
        undefined,
        variety,
        prepIds,
        arrangedOrder ?? undefined,
    );
    if (draftRes.status !== 200) {
        return { status: draftRes.status, body: draftRes.body };
    }

    const payload = (await source.hydrate(
        eventId,
    )) as Partial<HydrationPayload>;
    // The hydration songs are core-shaped (no public_id, which stays out of core), so pull the URL
    // tokens from the repository's song read models and join by uuid. Both are the ensemble's active
    // songs, so every catalog id resolves; the fallback only guards an impossible mismatch.
    const songTokens = new Map(
        (await repo.listSongs()).map((s) => [s.id, s.publicId]),
    );
    const catalog = (payload.songs ?? []).map((s) => ({
        id: s.id,
        publicId: songTokens.get(s.id) ?? s.id,
        title: s.title,
        meta: songMeta(s),
    }));
    const pins = reconcilePins(locks, new Set(catalog.map((c) => c.id)));
    const setEntries = songsOf(draftRes.body.set);
    const songIds = setEntries.map((e) => e.song.id);
    const notes = await repo.getItemNotes(setlistId, songIds);
    const transitions = await repo.getTransitions(setlistId, songIds);

    // Cast check per set song against the confirmed-in participants. Only PINNED songs can fail
    // here (a preferred prep song that could not be cast already benched, and every non-forced
    // infeasible song dropped), so this flags exactly the hard-pinned songs the director forced in
    // that the confirmed cast can't cover.
    const partsBySong = indexBySong(payload.parts ?? []);
    const castingsByPart = indexByPart(payload.castings ?? []);
    const availableIn = new Set(
        (payload.availability ?? [])
            .filter((a) => a.status === "in")
            .map((a) => a.memberId),
    );
    const castShort: Record<string, string[]> = {};
    for (const entry of setEntries) {
        const feas = checkFeasibility({
            songIndex: {
                song: entry.song,
                parts: partsBySong.get(entry.song.id) ?? [],
            },
            castingsByPart,
            availableMemberIds: availableIn,
        });
        if (!feas.feasible)
            castShort[entry.song.id] = feas.shortParts.map((p) => p.label);
    }

    // Committed prep songs the draft could not place. With prep preferred, not forced, an uncastable
    // commitment drops at feasibility and an over-budget one benches; either way it is out of the set.
    // Surface each with a reason so the director can recast, trim, or swap in a replacement. A prep
    // song the director explicitly excluded from THIS set is intentionally out, so it is not flagged.
    const setIdSet = new Set(setEntries.map((e) => e.song.id));
    const excludedSet = new Set(pins.excluded);
    const benchIds = new Set(draftRes.body.bench.map((b) => b.song.id));
    const dropById = new Map(draftRes.body.drops.map((d) => [d.song.id, d]));
    const titleById = new Map(catalog.map((c) => [c.id, c.title]));
    const unplacedPrep: SetlistDraftPayload["unplacedPrep"] = [];
    for (const id of prepIds) {
        if (setIdSet.has(id) || excludedSet.has(id)) continue;
        const drop = dropById.get(id);
        const title = titleById.get(id) ?? id;
        if (drop?.stage === "feasibility") {
            unplacedPrep.push({
                songId: id,
                title,
                reason: "cast",
                shortParts: drop.detail ? drop.detail.split(", ") : [],
            });
        } else if (benchIds.has(id)) {
            unplacedPrep.push({ songId: id, title, reason: "room" });
        } else if (drop?.stage === "data") {
            unplacedPrep.push({ songId: id, title, reason: "data" });
        }
        // Any other absence (e.g. archived after commitment) has no actionable reason, so skip it.
    }

    return {
        status: 200,
        body: {
            setlistId,
            eventId,
            draft: draftRes.body,
            pins,
            catalog,
            notes,
            transitions,
            // The breaks core actually placed (clamped/deduped), so the editable view and the
            // draft agree on where every intermission sits.
            breaks: breaksOf(draftRes.body.set),
            castShort,
            prepIds, // the gig's committed songs, so the editor can show + toggle per-song prep membership
            unplacedPrep, // committed prep the draft could not place (can't cast / no room), with reasons
        },
    };
}

// The frozen, member-safe view of a setlist. A member must NEVER run the drafter (loadSetlist): it
// would return the bench, drops, feasibility shortfalls, and the whole active-song catalog. Per
// migration 051 a member reads only the frozen snapshot — the performed order, the published order,
// or (when the director is sharing) the live draft's stored order. getPublishedSet returns
// performed-or-published; getSharedDraft returns a shared live draft. Between them they cover exactly
// what RLS makes a member-visible set; neither means the set is not member-visible (404). The payload
// shape mirrors loadSetlist's performed branch, so the client renders it uniformly (no pins, no
// bench, no drops, an empty catalog beyond the set's own songs).
export async function loadFrozenSnapshot(
    repo: Repository,
    setlistId: string,
): Promise<LoadResult> {
    const pub =
        (await repo.getPublishedSet(setlistId)) ??
        (await repo.getSharedDraft(setlistId));
    if (!pub)
        return {
            status: 404,
            body: { error: "setlist not found or not visible" },
        };
    const songItems: SongItem[] = pub.songs.map((s) => ({
        kind: "song",
        song: s,
        stage: s.durationSeconds ?? 0,
    }));
    const set = interleaveBreaks(songItems, pub.breaks);
    const totalSeconds = clockSeconds(
        pub.songs,
        pub.padding,
        new Map(Object.entries(pub.transitions)),
        pub.breaks,
    );
    const draft: DraftWithChase = {
        set,
        bench: [],
        totalSeconds,
        targetSeconds: null,
        seams: [],
        sequenceCost: 0,
        shortfall: null,
        drops: [],
        chase: [],
    };
    return {
        status: 200,
        body: {
            setlistId,
            eventId: pub.eventId,
            draft,
            pins: EMPTY_PINS,
            catalog: pub.songs.map((s) => ({
                id: s.id,
                publicId: s.publicId ?? s.id,
                title: s.title,
                meta: songMeta(s),
            })),
            notes: pub.notes,
            transitions: pub.transitions,
            breaks: pub.breaks,
            castShort: {},
            prepIds: [],
            unplacedPrep: [],
        },
    };
}
