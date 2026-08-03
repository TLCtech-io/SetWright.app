// The Supabase data adapter. createSupabaseRepository(client) returns the Repository
// surface backed by the signed-in user's RLS-scoped client, so every method runs as
// that user and tenant isolation is drawn at the SQL boundary. It is a pure factory
// (no request/cookie coupling), so a test can build it from a programmatically
// signed-in client and exercise it against the live stack.
//
// Built domain by domain, each verified live before the next. Unimplemented methods
// throw a clear error rather than silently returning wrong data. The `: Repository`
// return annotation makes tsc reject any method whose shape drifts from the mock.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PADDING } from "../db";
import type {
    EventInput,
    EventRow,
    EventTypeRow,
    MemberInput,
    MemberRow,
    PlaygroundMeta,
    ResolvedEventTypePreset,
    SongRow,
} from "../db";
import type { Repository } from "../repository";
import type { WriteResult } from "../writeResult";
import {
    ATTENDANCE_SELECT,
    EVENT_SELECT,
    EVENT_TYPE_SELECT,
    MEMBER_SELECT,
    PROGRAM_SELECT,
    REHEARSAL_ITEM_SELECT,
    SONG_SELECT,
    toAttendanceItem,
    toEventRow,
    toEventTypeRow,
    toMemberRow,
    toMockCasting,
    toMockPart,
    toPaddingProfileRow,
    toPlaygroundMeta,
    toRehearsalAgendaItem,
    toSongRow,
    toTagRow,
    toVoicePartRow,
} from "./map";
import { dbError } from "./errors";
import { pageAll } from "./paging";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// The frozen performed-set snapshot stored in setlist.performed_snapshot: the performed
// songs (full SongRow shape, in order) plus the event name and padding, captured at perform time so
// the historical sheet and totals never shift when a song or event is edited later.
type PerformedSnapshot = {
    songs: SongRow[];
    eventName: string;
    padding: { perSongSeconds: number; perSetSeconds: number };
};

// Throw on a PostgREST error, else hand back the data. dbError sanitizes: a generic
// client-facing message with the raw error kept only on `cause` for server logs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap<T>(res: { data: T; error: any }): T {
    if (res.error) throw dbError(res.error);
    return res.data;
}

// PostgREST caps a single select at its max-rows setting (1000 by default) and silently truncates
// a larger result, so an unpaged list read of a big book/roster/history/tag-usage would drop rows.
// Page a scoped list read to completion (pageAll does the loop). `build` must create a FRESH query
// each call (PostgREST .order() is additive, so a reused builder would stack clauses) with a STABLE
// total order (a unique tiebreak) so pages never overlap or skip. This is the shared form of the
// paging getEnsembleCoverage spells out inline.
async function selectAll(
    build: (
        from: number,
        to: number,
    ) => PromiseLike<{ data: unknown; error: any }>,
): Promise<Row[]> {
    return pageAll(
        async (from, to) => (unwrap(await build(from, to)) ?? []) as Row[],
    );
}

// The JSON the set_availability / set_breaks / set_song_casting RPCs return — they do the
// optimistic claim + collection rewrite in one transaction (so the parent row lock is held
// across the replace) and report the outcome. Map it to the Repository's WriteResult.
type WriteRpc = {
    ok: boolean;
    reason?: "not_found" | "conflict";
    version?: string;
};
const fromWriteRpc = (out: WriteRpc): WriteResult =>
    out.ok
        ? { ok: true, version: out.version as string }
        : { ok: false, reason: out.reason as "not_found" | "conflict" };

async function getSongById(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<SongRow | undefined> {
    const row = unwrap(
        await client
            .from("song")
            .select(SONG_SELECT)
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return row
        ? { ...toSongRow(row), version: row.updated_at as string }
        : undefined;
}

// A unique-constraint violation (duplicate name/label) — the write paths turn it into
// a {ok:false, reason:'duplicate'} instead of throwing, matching the mock.
function isDup(error: { code?: string } | null): boolean {
    return error?.code === "23505";
}

// next sort_order for an ensemble's vocabulary (max + 1, else 0).
async function nextSortOrder(
    client: SupabaseClient,
    table: string,
    ensemble_id: string,
): Promise<number> {
    const rows = (unwrap(
        await client
            .from(table)
            .select("sort_order")
            .eq("ensemble_id", ensemble_id)
            .order("sort_order", { ascending: false })
            .limit(1),
    ) ?? []) as Row[];
    return rows.length ? (rows[0]!.sort_order as number) + 1 : 0;
}

// Honor a padding-profile reference only if it resolves; else null (the type falls
// back to DEFAULT_PADDING). Mirrors the mock's validProfileId + the schema SET NULL.
async function validProfileId(
    client: SupabaseClient,
    ensemble_id: string,
    id: string | null,
): Promise<string | null> {
    if (!id) return null;
    const row = unwrap(
        await client
            .from("padding_profile")
            .select("id")
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return row ? id : null;
}

async function getMemberById(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<MemberRow | undefined> {
    const row = unwrap(
        await client
            .from("member")
            .select(MEMBER_SELECT)
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return row ? toMemberRow(row) : undefined;
}

// The member columns + sections shaped for the save_member RPC (snake_case to match the table).
function memberData(input: MemberInput): Record<string, unknown> {
    return {
        display_name: input.displayName,
        permission_tier: input.role,
        is_singing: input.singing,
        vocal_range_low: input.rangeLowMidi,
        vocal_range_high: input.rangeHighMidi,
    };
}
function memberSections(
    input: MemberInput,
): Array<{ voice_part_id: string; is_primary: boolean }> {
    return input.sections.map((s) => ({
        voice_part_id: s.voicePartId,
        is_primary: s.isPrimary,
    }));
}

// The event columns shaped for the save_event RPC (snake_case to match the table).
function eventData(input: EventInput): Record<string, unknown> {
    return {
        name: input.name,
        venue: input.venue,
        status: input.status,
        kind: input.kind,
        event_type_id: input.eventTypeId,
        event_date: input.eventDate,
        target_duration_seconds: input.targetDurationSeconds,
        max_duration_seconds: input.maxDurationSeconds,
        allows_on_book: input.allowsOnBook,
        allows_explicit: input.allowsExplicit,
        allows_accompaniment: input.allowsAccompaniment,
        per_song_seconds: input.perSongSeconds,
        per_set_seconds: input.perSetSeconds,
    };
}

async function activeDirectorsExcluding(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<number> {
    const { count } = await client
        .from("member")
        .select("id", { count: "exact", head: true })
        .eq("ensemble_id", ensemble_id)
        .eq("status", "active")
        .eq("permission_tier", "director")
        .neq("id", id);
    return count ?? 0;
}

async function getEventById(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<EventRow | undefined> {
    const row = unwrap(
        await client
            .from("event")
            .select(EVENT_SELECT)
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return row
        ? { ...toEventRow(row), version: row.updated_at as string }
        : undefined;
}

async function getEventTypeById(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<EventTypeRow | undefined> {
    const row = unwrap(
        await client
            .from("event_type")
            .select(EVENT_TYPE_SELECT)
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return row ? toEventTypeRow(row) : undefined;
}

// The resolved defaults a type stamps onto an event: padding from its profile (or
// DEFAULT_PADDING if none/dangling), the policy flags, and its tag rules (exclude-wins).
async function resolvePreset(
    client: SupabaseClient,
    ensemble_id: string,
    t: EventTypeRow,
): Promise<ResolvedEventTypePreset> {
    let perSongSeconds = DEFAULT_PADDING.perSongSeconds;
    let perSetSeconds = DEFAULT_PADDING.perSetSeconds;
    if (t.paddingProfileId) {
        const pp = unwrap(
            await client
                .from("padding_profile")
                .select("per_song_seconds, per_set_seconds")
                .eq("ensemble_id", ensemble_id)
                .eq("id", t.paddingProfileId)
                .maybeSingle(),
        ) as Row | null;
        if (pp) {
            perSongSeconds = pp.per_song_seconds;
            perSetSeconds = pp.per_set_seconds;
        }
    }
    return {
        allowsOnBook: t.defaultAllowsOnBook,
        allowsExplicit: t.defaultAllowsExplicit,
        allowsAccompaniment: t.defaultAllowsAccompaniment,
        perSongSeconds,
        perSetSeconds,
        excludeTags: [...t.excludeTags],
        preferTags: t.preferTags.filter((n) => !t.excludeTags.includes(n)),
        requireTags: t.requireTags.filter((n) => !t.excludeTags.includes(n)),
    };
}

// --- setlist_item write model ----------------------------------------------------
// One row per (setlist, song) carries pin / is_excluded / note / transition_seconds /
// position. The CHECK requires a position on every non-excluded row, but no draft-path
// SQL reads it (hydrate_setlist_locks ignores position) and there is no uniqueness on
// it, so draft rows use a filler position 0. markPerformed writes the real 1..N order,
// which getPerformedSet reads.

// (The performed-order freeze + soloist snapshot now live in the perform_setlist RPC,
// so the adapter's markPerformed is a single transactional call — see below.)

async function getPlaygroundById(
    client: SupabaseClient,
    ensemble_id: string,
    id: string,
): Promise<PlaygroundMeta | undefined> {
    const r = unwrap(
        await client
            .from("program")
            .select(PROGRAM_SELECT)
            .eq("ensemble_id", ensemble_id)
            .eq("id", id)
            .maybeSingle(),
    ) as Row | null;
    return r ? toPlaygroundMeta(r) : undefined;
}

export function createSupabaseRepository(
    client: SupabaseClient,
    requestedEnsemble?: string,
): Repository {
    // The ensemble all of this repository's reads and writes are scoped to. A user can
    // belong to several ensembles, so RLS alone returns rows from all of them — every
    // ensemble-scoped query filters by this. It's the requested one (from the active-
    // ensemble cookie / the /e/:id URL) when the caller is an active member, else their
    // first membership. Resolved once and cached for the life of the request's repo.
    // The signed-in user's id, resolved once via getUser() and cached as a promise so concurrent
    // callers dedupe too. Both activeEnsemble and myMemberId need it; without this a cold
    // myMemberId() would hit getUser() twice. The repo is per-request, so this never leaks users.
    let _uid: Promise<string> | undefined;
    function currentUserId(): Promise<string> {
        _uid ??= client.auth.getUser().then(({ data }) => {
            const uid = data.user?.id;
            if (!uid) throw new Error("not authenticated");
            return uid;
        });
        return _uid;
    }

    let _ensemble: string | undefined;
    async function activeEnsemble(): Promise<string> {
        if (_ensemble) return _ensemble;
        const uid = await currentUserId();
        const rows = (unwrap(
            await client
                .from("member")
                .select("ensemble_id")
                .eq("user_id", uid)
                .eq("status", "active"),
        ) ?? []) as Row[];
        const ids = rows.map((r) => r.ensemble_id as string);
        if (ids.length === 0)
            throw new Error("no active membership for the current user");
        _ensemble =
            requestedEnsemble && ids.includes(requestedEnsemble)
                ? requestedEnsemble
                : ids[0]!;
        return _ensemble;
    }

    // The caller's own member id in the active ensemble — for the self-service reads/writes
    // that are scoped to "me" (my castings, my confidence). Cached for the request.
    let _me: string | undefined;
    async function myMemberId(): Promise<string> {
        if (_me) return _me;
        const uid = await currentUserId();
        const ens = await activeEnsemble();
        const row = unwrap(
            await client
                .from("member")
                .select("id")
                .eq("ensemble_id", ens)
                .eq("user_id", uid)
                .eq("status", "active")
                .maybeSingle(),
        ) as Row | null;
        if (!row) throw new Error("no active membership for the current user");
        _me = row.id as string;
        return _me;
    }

    // Does this row belong to the active ensemble? RLS authorizes every ensemble the user is in,
    // so the transactional RPCs (save_song / set_* / perform_setlist) — which claim by id, not by
    // ensemble — would otherwise let a multi-ensemble director write another of their ensembles'
    // rows by id. Gate those calls on this first.
    async function ownedInEnsemble(
        table: string,
        id: string,
    ): Promise<boolean> {
        const ens = await activeEnsemble();
        const r = unwrap(
            await client
                .from(table)
                .select("id")
                .eq("ensemble_id", ens)
                .eq("id", id)
                .maybeSingle(),
        ) as Row | null;
        return !!r;
    }

    return {
        // --- Ensemble settings (the tenant row) -------------------------------------
        getEnsembleSettings: async () => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("ensemble")
                    .select("name, timezone, confidence_visibility, updated_at")
                    .eq("id", ens)
                    .single(),
            ) as Row;
            return {
                name: r.name as string,
                timezone: r.timezone as string,
                confidenceVisibility: r.confidence_visibility as
                    | "private"
                    | "shared",
                version: r.updated_at as string,
            };
        },
        updateEnsembleSettings: async (input, expectedVersion) => {
            const ens = await activeEnsemble();
            // Guard the write on the loaded version (ensemble.updated_at, moddatetime-maintained) so a
            // concurrent director edit can't silently clobber -- privacy-relevant for confidence
            // visibility. RLS (ensemble_update) authorizes this only for the director.
            const rows = unwrap(
                await client
                    .from("ensemble")
                    .update({
                        name: input.name,
                        timezone: input.timezone,
                        confidence_visibility: input.confidenceVisibility,
                    })
                    .eq("id", ens)
                    .eq("updated_at", expectedVersion)
                    .select("updated_at"),
            ) as Row[];
            if (rows.length > 0)
                return { ok: true, version: rows[0]!.updated_at as string };
            // 0 rows: a stale token AND a non-director both match nothing. Re-read the row (any member
            // may) to tell them apart -- if the version moved it was a lost race (conflict); if it still
            // equals the token, the write was RLS-denied (forbidden, i.e. not a director).
            const cur = unwrap(
                await client
                    .from("ensemble")
                    .select("updated_at")
                    .eq("id", ens)
                    .maybeSingle(),
            ) as Row | null;
            if (cur && cur.updated_at !== expectedVersion)
                return { ok: false, reason: "conflict" };
            return { ok: false, reason: "forbidden" };
        },

        // --- Public id resolution ---------------------------------------------------
        // Resolve a URL token to the internal uuid within the active ensemble, or null. The entity
        // name is the table name for all five routable inner rows. Scoped by ensemble_id and RLS, so
        // a token from another tenant resolves to null, never leaks a row. The unique index on
        // public_id makes this a point lookup.
        resolvePublicId: async (entity, publicId) => {
            const ens = await activeEnsemble();
            const row = unwrap(
                await client
                    .from(entity)
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("public_id", publicId)
                    .maybeSingle(),
            ) as Row | null;
            return row ? (row.id as string) : null;
        },

        // --- Songs + parts + casting ------------------------------------------------
        listSongs: async () => {
            const ens = await activeEnsemble();
            // Paged: a book over 1000 songs would otherwise be silently truncated, dropping songs from the
            // repertoire, prep, and the setlist token map (id tiebreak keeps page boundaries stable).
            const rows = await selectAll((from, to) =>
                client
                    .from("song")
                    .select(SONG_SELECT)
                    .eq("ensemble_id", ens)
                    .order("created_at")
                    .order("id")
                    .range(from, to),
            );
            return rows.map(toSongRow);
        },
        getSong: async (id) => getSongById(client, await activeEnsemble(), id),
        getSongParts: async (songId) => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("part")
                    .select("*")
                    .eq("ensemble_id", ens)
                    .eq("song_id", songId)
                    .order("sort_order")
                    .order("created_at"),
            ) ?? []) as Row[];
            return rows.map(toMockPart);
        },
        getSongCasting: async (songId) => {
            const ens = await activeEnsemble();
            const partRows = (unwrap(
                await client
                    .from("part")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("song_id", songId),
            ) ?? []) as Row[];
            const partIds = partRows.map((p) => p.id as string);
            if (partIds.length === 0) return [];
            const rows = (unwrap(
                await client
                    .from("casting_visible")
                    .select("*")
                    .in("part_id", partIds),
            ) ?? []) as Row[];
            return rows.map(toMockCasting);
        },
        getEnsembleCoverage: async () => {
            const ens = await activeEnsemble();
            // Two ensemble-wide reads replace the per-song getSongParts+getSongCasting fan-out (the N+1).
            // Both scope by ensemble_id (casting_visible exposes it) rather than an all-parts IN list, so no
            // giant part-id URL is built, and both PAGE through the rows so a large book is never silently
            // truncated at PostgREST's default 1000-row cap (which would understate coverage). casting_visible
            // preserves confidence masking (a director sees every self-report, a member sees them nulled).
            // RLS + the ensemble_id filter scope both reads to the caller's ensemble. Parts keep getSongParts'
            // sort_order,created_at order (plus id, a stable tiebreak so pages never overlap or skip); casting
            // order is not significant (an accepted mock/adapter difference).
            //
            // Paging advances by the ACTUAL rows a page returned and stops only on an EMPTY page: a short but
            // non-empty page means the server capped it (a low max-rows), NOT end-of-data, so keep going. `from`
            // strictly increases while rows arrive, so finite data always terminates.
            const PAGE = 1000;
            const partRows: Row[] = [];
            for (let from = 0; ; ) {
                const rows = (unwrap(
                    await client
                        .from("part")
                        .select("*")
                        .eq("ensemble_id", ens)
                        .order("sort_order")
                        .order("created_at")
                        .order("id")
                        .range(from, from + PAGE - 1),
                ) ?? []) as Row[];
                if (rows.length === 0) break;
                partRows.push(...rows);
                from += rows.length;
            }
            const castingRows: Row[] = [];
            for (let from = 0; ; ) {
                const rows = (unwrap(
                    await client
                        .from("casting_visible")
                        .select("*")
                        .eq("ensemble_id", ens)
                        .order("id")
                        .range(from, from + PAGE - 1),
                ) ?? []) as Row[];
                if (rows.length === 0) break;
                castingRows.push(...rows);
                from += rows.length;
            }
            return {
                parts: partRows.map(toMockPart),
                castings: castingRows.map(toMockCasting),
            };
        },
        listMyCastings: async () => {
            const ens = await activeEnsemble();
            const me = await myMemberId();
            // casting_visible already hides other members' confidence; filtered to me, every row
            // is my own self-report. Resolve the full part + song (both member-readable) through
            // the canonical mappers so the widened projection carries no column-name drift.
            const rows = (unwrap(
                await client
                    .from("casting_visible")
                    .select("part_id, is_primary, self_reported_confidence")
                    .eq("member_id", me),
            ) ?? []) as Row[];
            if (rows.length === 0) return [];
            const partIds = rows.map((r) => r.part_id as string);
            const partRows = (unwrap(
                await client
                    .from("part")
                    .select("*")
                    .eq("ensemble_id", ens)
                    .in("id", partIds),
            ) ?? []) as Row[];
            const partById = new Map(
                partRows.map((p) => [p.id as string, toMockPart(p)]),
            );
            const songIds = [
                ...new Set(partRows.map((p) => p.song_id as string)),
            ];
            const songRows = songIds.length
                ? ((unwrap(
                      await client
                          .from("song")
                          .select(SONG_SELECT)
                          .eq("ensemble_id", ens)
                          .in("id", songIds),
                  ) ?? []) as Row[])
                : [];
            const songById = new Map(
                songRows.map((s) => [s.id as string, toSongRow(s)]),
            );
            return rows.map((r) => {
                const part = partById.get(r.part_id as string);
                const song = part ? songById.get(part.songId) : undefined;
                return {
                    partId: r.part_id as string,
                    songId: part?.songId ?? "",
                    songTitle: song?.title ?? "(unknown song)",
                    partLabel: part?.label ?? "(part)",
                    isLead: r.is_primary as boolean,
                    isSolo: part?.isSolo ?? false,
                    confidence: (r.self_reported_confidence ?? null) as
                        | "solid"
                        | "shaky"
                        | "learning"
                        | null,
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
        },
        listMyPartCoverage: async () => {
            const ens = await activeEnsemble();
            const me = await myMemberId();
            // My castings -> the parts I cover.
            const mine = (unwrap(
                await client
                    .from("casting_visible")
                    .select("part_id")
                    .eq("member_id", me),
            ) ?? []) as Row[];
            const partIds = [...new Set(mine.map((r) => r.part_id as string))];
            if (partIds.length === 0) return [];
            // How many singers each part wants.
            const partRows = (unwrap(
                await client
                    .from("part")
                    .select("id, count_needed")
                    .eq("ensemble_id", ens)
                    .in("id", partIds),
            ) ?? []) as Row[];
            const countById = new Map(
                partRows.map((p) => [p.id as string, p.count_needed as number]),
            );
            // Everyone cast on those parts. casting_visible already nulls another member's
            // self-confidence unless the ensemble shares it, and always shows the caller their own,
            // so reading self_reported_confidence straight gives the right per-cover gating.
            const rows = (unwrap(
                await client
                    .from("casting_visible")
                    .select(
                        "part_id, member_id, is_primary, self_reported_confidence",
                    )
                    .in("part_id", partIds),
            ) ?? []) as Row[];
            const memberIds = [
                ...new Set(rows.map((r) => r.member_id as string)),
            ];
            const memberRows = memberIds.length
                ? ((unwrap(
                      await client
                          .from("member")
                          .select("id, display_name")
                          .eq("ensemble_id", ens)
                          .in("id", memberIds),
                  ) ?? []) as Row[])
                : [];
            const nameById = new Map(
                memberRows.map((m) => [
                    m.id as string,
                    m.display_name as string,
                ]),
            );
            const byPart = new Map<string, Row[]>();
            for (const r of rows) {
                const list = byPart.get(r.part_id as string);
                if (list) list.push(r);
                else byPart.set(r.part_id as string, [r]);
            }
            const orderCovers = (
                a: { isSelf: boolean; displayName: string },
                b: { isSelf: boolean; displayName: string },
            ) =>
                a.isSelf === b.isSelf
                    ? a.displayName.localeCompare(b.displayName)
                    : a.isSelf
                      ? -1
                      : 1;
            return partIds.map((partId) => {
                const covers = (byPart.get(partId) ?? [])
                    .map((r) => {
                        const isSelf = (r.member_id as string) === me;
                        return {
                            memberId: r.member_id as string,
                            displayName:
                                nameById.get(r.member_id as string) ??
                                "(unknown)",
                            isLead: r.is_primary as boolean,
                            isSelf,
                            confidence: (r.self_reported_confidence ?? null) as
                                | "solid"
                                | "shaky"
                                | "learning"
                                | null,
                        };
                    })
                    .sort(orderCovers);
                return {
                    partId,
                    countNeeded: countById.get(partId) ?? 1,
                    covers,
                };
            });
        },
        setMyConfidence: async (partId, confidence) => {
            // Resolve the casting by (part_id, caller) INSIDE the RPC (set_my_confidence takes p_part now),
            // atomically. The old two-step — read the casting id, then write it — could strand a stale id if
            // a concurrent director casting save deleted+reinserted the rows with fresh ids between the two.
            // The RPC is owner-scoped (updates only the caller's own casting); a non-cast member no-ops (0 rows).
            unwrap(
                await client.rpc("set_my_confidence", {
                    p_part: partId,
                    p_confidence: confidence,
                }),
            );
        },
        createSong: async (input) => {
            const ensemble_id = await activeEnsemble();
            const s = input.song;
            // One transaction: a failed part/tag insert rolls the song back — no ghost song.
            const data = {
                title: s.title,
                arranger: input.arranger,
                chart_ref: input.chartRef,
                start_key_fifths: s.startKey?.fifths ?? null,
                start_key_mode: s.startKey?.mode ?? null,
                end_key_fifths: s.endKey?.fifths ?? null,
                end_key_mode: s.endKey?.mode ?? null,
                start_tempo_bpm: s.startTempoBpm,
                end_tempo_bpm: s.endTempoBpm,
                start_pitch: input.startPitch,
                duration_seconds: s.durationSeconds,
                is_explicit: s.isExplicit,
                uses_accompaniment: s.usesAccompaniment,
                intensity: s.intensity,
                assessed_readiness: s.assessedReadiness,
                book_status: s.bookStatus,
                last_rehearsed: input.lastRehearsed,
            };
            const parts = input.parts.map((p) => ({
                label: p.label,
                is_required: p.isRequired,
                count_needed: p.countNeeded,
                voice_part_id: p.voicePartId,
                is_solo: p.isSolo,
                range_low: p.rangeLowMidi,
                range_high: p.rangeHighMidi,
            }));
            const out = unwrap(
                await client.rpc("create_song", {
                    p_ensemble: ensemble_id,
                    p_data: data,
                    p_tags: s.tags.map((t) => t.name),
                    p_parts: parts,
                }),
            ) as { ok: boolean; id: string };
            return (await getSongById(client, ensemble_id, out.id))!;
        },
        updateSong: async (id, input, expectedVersion) => {
            if (!(await ownedInEnsemble("song", id)))
                return { ok: false, reason: "not_found" };
            const s = input.song;
            // One transactional RPC: claim the song on its version, then rewrite tags + parts in the
            // same transaction. A constraint error anywhere rolls the whole save back (incl. the
            // version claim), so the title/version never advance without the tags/parts.
            // p_data carries the song columns; p_tags the names; p_parts the part rows.
            const result = unwrap(
                await client.rpc("save_song", {
                    p_song: id,
                    p_expected: expectedVersion,
                    p_data: {
                        title: s.title,
                        arranger: input.arranger,
                        chart_ref: input.chartRef,
                        start_key_fifths: s.startKey?.fifths ?? null,
                        start_key_mode: s.startKey?.mode ?? null,
                        end_key_fifths: s.endKey?.fifths ?? null,
                        end_key_mode: s.endKey?.mode ?? null,
                        start_tempo_bpm: s.startTempoBpm,
                        end_tempo_bpm: s.endTempoBpm,
                        start_pitch: input.startPitch,
                        duration_seconds: s.durationSeconds,
                        is_explicit: s.isExplicit,
                        uses_accompaniment: s.usesAccompaniment,
                        intensity: s.intensity,
                        assessed_readiness: s.assessedReadiness,
                        book_status: s.bookStatus,
                        last_rehearsed: input.lastRehearsed,
                    },
                    p_tags: s.tags.map((t) => t.name),
                    p_parts: input.parts.map((p) => ({
                        id: p.id ?? null,
                        label: p.label,
                        is_required: p.isRequired,
                        count_needed: p.countNeeded,
                        voice_part_id: p.voicePartId ?? null,
                        is_solo: p.isSolo,
                        range_low: p.rangeLowMidi,
                        range_high: p.rangeHighMidi,
                    })),
                }),
            ) as WriteRpc;
            return fromWriteRpc(result);
        },
        setSongStatus: async (id, status) => {
            const ens = await activeEnsemble();
            const updated = unwrap(
                await client
                    .from("song")
                    .update({ status })
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .select("id"),
            ) as Row[];
            if (!updated || updated.length === 0) return undefined;
            return getSongById(client, ens, id);
        },
        setSongCasting: async (songId, next, expectedVersion) => {
            if (!(await ownedInEnsemble("song", songId)))
                return { ok: false, reason: "not_found" };
            // The RPC claims the song version + rewrites casting in one transaction. It owns the
            // learned_at derivation and preserves each member's self_reported_confidence from the
            // prior row (never the payload — the member owns that column), so we send only the
            // director-controlled fields.
            const out = unwrap(
                await client.rpc("set_song_casting", {
                    p_song: songId,
                    p_expected: expectedVersion,
                    p_rows: next.map((c) => ({
                        partId: c.partId,
                        memberId: c.memberId,
                        isPrimary: c.isPrimary,
                        directorAssessed: c.directorAssessed,
                    })),
                }),
            ) as WriteRpc;
            return fromWriteRpc(out);
        },

        // --- Events ----------------------------------------------------------------
        listEvents: async (opts) => {
            const ens = await activeEnsemble();
            const kind = opts?.kind ?? "gig"; // fail-closed: default excludes rehearsals
            // Paged: an event history over 1000 rows would otherwise be truncated (id tiebreak keeps page
            // boundaries stable). A fresh query per page — .order() is additive on a reused builder.
            const rows = await selectAll((from, to) => {
                const base = client
                    .from("event")
                    .select(EVENT_SELECT)
                    .eq("ensemble_id", ens);
                const filtered = kind === "all" ? base : base.eq("kind", kind);
                return filtered.order("created_at").order("id").range(from, to);
            });
            return rows.map(toEventRow);
        },
        getEvent: async (id) =>
            getEventById(client, await activeEnsemble(), id),
        getEventSetlists: async (eventId) => {
            const ens = await activeEnsemble();
            // Order by created_at, id as the tiebreak. ids are v4 and carry no time order, so
            // created_at is what matches the mock's insertion order.
            const rows = (unwrap(
                await client
                    .from("setlist")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("event_id", eventId)
                    .order("created_at")
                    .order("id"),
            ) ?? []) as Row[];
            return rows.map((r) => r.id as string);
        },
        getRehearsalAgenda: async (eventId) => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("rehearsal_item")
                    .select(REHEARSAL_ITEM_SELECT)
                    .eq("ensemble_id", ens)
                    .eq("event_id", eventId)
                    .order("position"),
            ) ?? []) as Row[];
            return rows.map(toRehearsalAgendaItem);
        },
        saveRehearsalAgenda: async (eventId, items) => {
            // save_rehearsal_agenda replaces the whole list in one transaction (delete + insert
            // by array order), and guards kind so a gig can't acquire an agenda. RLS gates the
            // write to a director. p_items carries snake_case, matching the RPC.
            unwrap(
                await client.rpc("save_rehearsal_agenda", {
                    p_event: eventId,
                    p_items: items.map((i) => ({
                        song_id: i.songId,
                        reason: i.reason,
                        note: i.note,
                    })),
                }),
            );
        },
        markSongsRehearsed: async (songIds, date) => {
            // mark_songs_rehearsed stamps last_rehearsed = greatest(...) for the given songs.
            // Director-gated in the RPC; idempotent. p_ensemble scopes the tenant.
            unwrap(
                await client.rpc("mark_songs_rehearsed", {
                    p_ensemble: await activeEnsemble(),
                    p_songs: songIds,
                    p_date: date,
                }),
            );
        },
        getAttendance: async (eventId) => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("attendance")
                    .select(ATTENDANCE_SELECT)
                    .eq("ensemble_id", ens)
                    .eq("event_id", eventId),
            ) ?? []) as Row[];
            return rows.map(toAttendanceItem);
        },
        saveAttendance: async (eventId, rows) => {
            // save_attendance replaces the event's attendance in one write (delete + insert),
            // director-gated by RLS. p_rows carries snake_case, matching the RPC.
            unwrap(
                await client.rpc("save_attendance", {
                    p_event: eventId,
                    p_rows: rows.map((r) => ({
                        member_id: r.memberId,
                        present: r.present,
                    })),
                }),
            );
        },
        getPrepTargets: async (eventId) => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("prep_target")
                    .select("song_id")
                    .eq("ensemble_id", ens)
                    .eq("event_id", eventId)
                    .order("created_at"),
            ) ?? []) as Row[];
            return rows.map((r) => r.song_id as string);
        },
        savePrepTargets: async (eventId, songIds) => {
            // save_prep_targets replaces the gig's target set in one write, kind-guarded to a gig.
            // Director-write via RLS. song ids pass as a uuid[], matching the RPC.
            unwrap(
                await client.rpc("save_prep_targets", {
                    p_event: eventId,
                    p_song_ids: songIds,
                }),
            );
        },
        togglePrepTarget: async (eventId, songId, on) => {
            // Atomic single-row change instead of a read-modify-write of the whole set: two directors
            // toggling DIFFERENT songs on the same gig touch different rows and never clobber each other.
            // Director-write + tenancy are enforced by the prep_target RLS policy; the unique
            // (event_id, song_id) constraint makes the on-conflict insert idempotent. The route's
            // gig-kind guard stands in for save_prep_targets' server-side kind check.
            const ens = await activeEnsemble();
            if (on) {
                unwrap(
                    await client
                        .from("prep_target")
                        .upsert(
                            {
                                ensemble_id: ens,
                                event_id: eventId,
                                song_id: songId,
                            },
                            {
                                onConflict: "event_id,song_id",
                                ignoreDuplicates: true,
                            },
                        ),
                );
            } else {
                unwrap(
                    await client
                        .from("prep_target")
                        .delete()
                        .eq("ensemble_id", ens)
                        .eq("event_id", eventId)
                        .eq("song_id", songId),
                );
            }
        },
        createEvent: async (input) => {
            const ensemble_id = await activeEnsemble();
            // One transaction: insert the event, its tag rules, the seeded 'in' availability pool, and a
            // setlist — save_event does all four or none, so a failure can't strand a ghost event.
            const id = unwrap(
                await client.rpc("save_event", {
                    p_ensemble: ensemble_id,
                    p_event: null,
                    p_data: eventData(input),
                    p_exclude: input.excludeTags,
                    p_prefer: input.preferTags,
                    p_require: input.requireTags,
                }),
            ) as string;
            return (await getEventById(client, ensemble_id, id))!;
        },
        updateEvent: async (id, input) => {
            const ensemble_id = await activeEnsemble();
            // save_event updates the row and replaces its tag rules in one transaction; null = not found.
            const updated = unwrap(
                await client.rpc("save_event", {
                    p_ensemble: ensemble_id,
                    p_event: id,
                    p_data: eventData(input),
                    p_exclude: input.excludeTags,
                    p_prefer: input.preferTags,
                    p_require: input.requireTags,
                }),
            );
            if (!updated) return undefined;
            return getEventById(client, ensemble_id, id);
        },
        deleteEvent: async (id) => {
            const ens = await activeEnsemble();
            const event = unwrap(
                await client
                    .from("event")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!event) return { ok: false, reason: "not-found" };
            // A performed setlist is an immutable record; refuse to let its event delete
            // cascade-wipe it. Archive the event instead.
            const performed = unwrap(
                await client
                    .from("setlist")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("event_id", id)
                    .eq("status", "performed")
                    .limit(1)
                    .maybeSingle(),
            ) as Row | null;
            if (performed) return { ok: false, reason: "has-performed" };
            unwrap(
                await client
                    .from("event")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            ); // setlists cascade via FK
            return { ok: true };
        },
        setAvailability: async (eventId, availability, expectedVersion) => {
            if (!(await ownedInEnsemble("event", eventId)))
                return { ok: false, reason: "not_found" };
            const out = unwrap(
                await client.rpc("set_availability", {
                    p_event: eventId,
                    p_expected: expectedVersion,
                    p_rows: availability,
                }),
            ) as WriteRpc;
            return fromWriteRpc(out);
        },
        setMyAvailability: async (eventId, status) => {
            // The caller's own row only — set_my_availability resolves their member from auth.uid()
            // and the availability_write self RLS branch authorizes it (no director privilege).
            unwrap(
                await client.rpc("set_my_availability", {
                    p_event: eventId,
                    p_status: status,
                }),
            );
        },

        // --- Setlists --------------------------------------------------------------
        listEventSetlists: async (eventId) => {
            const ens = await activeEnsemble();
            // Order by created_at, id as the tiebreak, so "the event's first setlist" is stable in
            // production the way the mock's insertion order is in dev. ids are v4 and carry no time
            // order, so ordering by id alone would return an arbitrary first.
            const rows = (unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft",
                    )
                    .eq("ensemble_id", ens)
                    .eq("event_id", eventId)
                    .order("created_at")
                    .order("id"),
            ) ?? []) as Row[];
            return rows.map((r) => ({
                id: r.id,
                publicId: r.public_id,
                eventId: r.event_id,
                name: r.name,
                status: r.status,
                publishedAt: (r.published_at ?? null) as string | null,
                shareDraft: !!r.share_draft,
            }));
        },
        getSetlistMeta: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft, updated_at",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            return r
                ? {
                      id: r.id,
                      publicId: r.public_id,
                      eventId: r.event_id,
                      name: r.name,
                      status: r.status,
                      publishedAt: (r.published_at ?? null) as string | null,
                      shareDraft: !!r.share_draft,
                      version: r.updated_at as string,
                  }
                : undefined;
        },
        setlistLockReason: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select("status")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (r?.status === "performed")
                return "a performed set is read-only";
            if (r?.status === "final")
                return "this set is finalized: revert it to draft to edit";
            return null;
        },
        createSetlist: async (eventId, name, programId = null) => {
            const ens = await activeEnsemble();
            const event = unwrap(
                await client
                    .from("event")
                    .select("ensemble_id")
                    .eq("ensemble_id", ens)
                    .eq("id", eventId)
                    .maybeSingle(),
            ) as Row | null;
            if (!event) return undefined;
            const r = unwrap(
                await client
                    .from("setlist")
                    .insert({
                        ensemble_id: event.ensemble_id,
                        event_id: eventId,
                        program_id: programId,
                        name,
                        status: "draft",
                    })
                    .select("id, public_id, event_id, name, status")
                    .single(),
            ) as Row;
            // A freshly created set is always unpublished and unshared.
            return {
                id: r.id,
                publicId: r.public_id,
                eventId: r.event_id,
                name: r.name,
                status: r.status,
                publishedAt: null,
                shareDraft: false,
            };
        },
        updateSetlist: async (setlistId, patch) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r) return undefined;
            // A performed set is immutable, and 'performed' is reached only by performing.
            if (r.status === "performed" || patch.status === "performed")
                return undefined;
            const cols: Record<string, unknown> = {};
            if (patch.name !== undefined) cols.name = patch.name;
            if (patch.status !== undefined) cols.status = patch.status;
            // An empty patch is a no-op (PostgREST errors on an empty update), and the mock returns 200.
            if (Object.keys(cols).length === 0) {
                return {
                    id: r.id,
                    publicId: r.public_id,
                    eventId: r.event_id,
                    name: r.name,
                    status: r.status,
                    publishedAt: (r.published_at ?? null) as string | null,
                    shareDraft: !!r.share_draft,
                };
            }
            // maybeSingle, not single: an RLS-denied write updates zero rows — that is a clean
            // refusal (undefined, like the mock), not a PGRST116 500.
            const updated = unwrap(
                await client
                    .from("setlist")
                    .update(cols)
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft",
                    )
                    .maybeSingle(),
            ) as Row | null;
            if (!updated) return undefined;
            return {
                id: updated.id,
                publicId: updated.public_id,
                eventId: updated.event_id,
                name: updated.name,
                status: updated.status,
                publishedAt: (updated.published_at ?? null) as string | null,
                shareDraft: !!updated.share_draft,
            };
        },
        deleteSetlist: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select("status")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r) return { ok: false, reason: "not-found" };
            if (r.status === "performed")
                return { ok: false, reason: "performed" };
            unwrap(
                await client
                    .from("setlist")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId),
            );
            return { ok: true };
        },
        publishSetlist: async (setlistId, snapshot) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select("status")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r || r.status === "performed") return undefined;
            // Store the pre-frozen order the route captured, verbatim, into published_order (jsonb) +
            // published_at. The route did the freeze once, so the mock and this path persist the same set.
            const published_order = {
                songIds: snapshot.songIds,
                transitions: snapshot.transitions,
                breaks: snapshot.breaks,
            };
            const updated = unwrap(
                await client
                    .from("setlist")
                    .update({
                        published_at: new Date().toISOString(),
                        published_order,
                    })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft",
                    )
                    .maybeSingle(),
            ) as Row | null;
            if (!updated) return undefined;
            return {
                id: updated.id,
                publicId: updated.public_id,
                eventId: updated.event_id,
                name: updated.name,
                status: updated.status,
                publishedAt: (updated.published_at ?? null) as string | null,
                shareDraft: !!updated.share_draft,
            };
        },
        unpublishSetlist: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, event_id, name, status, published_at, share_draft",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r) return undefined;
            // A performed set stays visible on its status alone, and the performed-immutability trigger
            // rejects any update to the row, so unpublishing one is a no-op — return its meta unchanged
            // (matching the mock), never issuing an UPDATE that would 500.
            if (r.status === "performed") {
                return {
                    id: r.id,
                    publicId: r.public_id,
                    eventId: r.event_id,
                    name: r.name,
                    status: r.status,
                    publishedAt: (r.published_at ?? null) as string | null,
                    shareDraft: !!r.share_draft,
                };
            }
            const updated = unwrap(
                await client
                    .from("setlist")
                    .update({ published_at: null, published_order: null })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .select(
                        "id, public_id, event_id, name, status, share_draft",
                    )
                    .maybeSingle(),
            ) as Row | null;
            if (!updated) return undefined;
            return {
                id: updated.id,
                publicId: updated.public_id,
                eventId: updated.event_id,
                name: updated.name,
                status: updated.status,
                publishedAt: null,
                shareDraft: !!updated.share_draft,
            };
        },
        shareSetlistDraft: async (setlistId, snapshot) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select("status")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r || r.status === "performed") return undefined;
            // Store the pre-frozen order the share route captured into draft_order (jsonb) and turn on
            // share_draft. Not frozen: syncSharedDraftOrder refreshes it as the director edits.
            const draft_order = {
                songIds: snapshot.songIds,
                transitions: snapshot.transitions,
                breaks: snapshot.breaks,
            };
            const updated = unwrap(
                await client
                    .from("setlist")
                    .update({ share_draft: true, draft_order })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .select(
                        "id, public_id, event_id, name, status, published_at",
                    )
                    .maybeSingle(),
            ) as Row | null;
            if (!updated) return undefined;
            return {
                id: updated.id,
                publicId: updated.public_id,
                eventId: updated.event_id,
                name: updated.name,
                status: updated.status,
                publishedAt: (updated.published_at ?? null) as string | null,
                shareDraft: true,
            };
        },
        unshareSetlistDraft: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, event_id, name, status, published_at",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!r) return undefined;
            // A performed set is immutable (its trigger rejects updates) and visible on status alone, so
            // unsharing it is a no-op — return meta unchanged, matching the mock and unpublishSetlist.
            if (r.status === "performed") {
                return {
                    id: r.id,
                    publicId: r.public_id,
                    eventId: r.event_id,
                    name: r.name,
                    status: r.status,
                    publishedAt: (r.published_at ?? null) as string | null,
                    shareDraft: false,
                };
            }
            const updated = unwrap(
                await client
                    .from("setlist")
                    .update({ share_draft: false, draft_order: null })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .select(
                        "id, public_id, event_id, name, status, published_at",
                    )
                    .maybeSingle(),
            ) as Row | null;
            if (!updated) return undefined;
            return {
                id: updated.id,
                publicId: updated.public_id,
                eventId: updated.event_id,
                name: updated.name,
                status: updated.status,
                publishedAt: (updated.published_at ?? null) as string | null,
                shareDraft: false,
            };
        },
        syncSharedDraftOrder: async (setlistId, snapshot) => {
            const ens = await activeEnsemble();
            // Update draft_order ONLY where the set is currently shared and not performed: one guarded
            // UPDATE, so an unshared or performed set matches zero rows and nothing is written. Lets the
            // director's order edits call this unconditionally after a re-draft.
            const draft_order = {
                songIds: snapshot.songIds,
                transitions: snapshot.transitions,
                breaks: snapshot.breaks,
            };
            unwrap(
                await client
                    .from("setlist")
                    .update({ draft_order })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .eq("share_draft", true)
                    .neq("status", "performed"),
            );
        },
        syncPublishedOrder: async (setlistId, snapshot) => {
            const ens = await activeEnsemble();
            // Update published_order ONLY where the set is currently published (published_at set) and not
            // performed: one guarded UPDATE, so an unpublished or performed set matches zero rows and nothing
            // is written (the performed-immutability trigger is never reached). published_at is left
            // untouched, so the publish time + member-visibility gate is unchanged. Lets the director's order
            // edits call this unconditionally after a re-draft, mirroring syncSharedDraftOrder for the frozen
            // snapshot so a published set tracks the director's edits until it is performed.
            const published_order = {
                songIds: snapshot.songIds,
                transitions: snapshot.transitions,
                breaks: snapshot.breaks,
            };
            unwrap(
                await client
                    .from("setlist")
                    .update({ published_order })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .not("published_at", "is", null)
                    .neq("status", "performed"),
            );
        },
        setPins: async (setlistId, pins) => {
            // Preflight: the setlist must belong to the active ensemble (set_pins claims by id, not
            // ensemble, so a multi-ensemble director could otherwise write another of their sets by id).
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl) return;
            // Replace the draft's pins + exclusions, preserving notes/segues atomically: the delete +
            // re-insert (notes/segues snapshotted + restored, keep-a-row-only-if-meaningful) all live in
            // set_pins, so a failed insert (e.g. a pinned song since deleted) rolls back rather than wiping.
            unwrap(
                await client.rpc("set_pins", {
                    p_setlist: setlistId,
                    p_open: pins.open,
                    p_close: pins.close,
                    p_keep: pins.keep,
                    p_excluded: pins.excluded,
                }),
            );
        },
        getArrangedOrder: async (setlistId) => {
            const ens = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("setlist")
                    .select("arranged_order")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            const ao = r?.arranged_order;
            return Array.isArray(ao) ? (ao as string[]) : null;
        },
        setArrangedOrder: async (setlistId, order) => {
            const ens = await activeEnsemble();
            // Draft-only: the status='draft' predicate matches zero rows for a performed/final set, so its
            // frozen order is never disturbed. moddatetime bumps updated_at, so the /order route re-reads
            // and returns the new version for the editor's break-edit token.
            unwrap(
                await client
                    .from("setlist")
                    .update({
                        arranged_order: order && order.length ? order : null,
                    })
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .eq("status", "draft"),
            );
        },
        markPerformed: async (setlistId, order) => {
            const ens = await activeEnsemble();
            if (!(await ownedInEnsemble("setlist", setlistId))) return false;
            // Build the performed snapshot (song metadata + event name/padding) BEFORE the perform,
            // while the set is still a draft, and pass it INTO perform_setlist so the write is atomic with
            // the status flip. It cannot be a second UPDATE: setlist_immutable_guard raises on any update to
            // an already-performed row. Built via toSongRow (one mapping) from the SAME order perform freezes
            // (dedupe first occurrence, cap 512), so snap.songs aligns with the frozen setlist_item order.
            const frozen = [...new Set(order ?? [])].slice(0, 512);
            const slRow = unwrap(
                await client
                    .from("setlist")
                    .select("event_id")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            const songRows = frozen.length
                ? ((unwrap(
                      await client
                          .from("song")
                          .select(SONG_SELECT)
                          .eq("ensemble_id", ens)
                          .in("id", frozen),
                  ) ?? []) as Row[])
                : [];
            const byId = new Map(
                songRows.map((r) => [r.id as string, toSongRow(r)]),
            );
            const snapSongs = frozen
                .map((id) => byId.get(id))
                .filter((s): s is SongRow => s !== undefined);
            const ev = slRow
                ? (unwrap(
                      await client
                          .from("event")
                          .select("name, per_song_seconds, per_set_seconds")
                          .eq("ensemble_id", ens)
                          .eq("id", slRow.event_id)
                          .maybeSingle(),
                  ) as Row | null)
                : null;
            const snapshot: PerformedSnapshot = {
                songs: snapSongs,
                eventName: (ev?.name as string) ?? "Event",
                padding: ev
                    ? {
                          perSongSeconds: ev.per_song_seconds as number,
                          perSetSeconds: ev.per_set_seconds as number,
                      }
                    : { ...DEFAULT_PADDING },
            };
            // One transactional RPC: freezes the order into setlist_item, the snapshot into
            // performed_snapshot, snapshots soloists, stamps status + performed_date + song.last_performed,
            // and returns false on a missing / already-performed / empty set or a non-director caller.
            const { data, error } = await client.rpc("perform_setlist", {
                p_setlist: setlistId,
                p_order: order ?? [],
                p_snapshot: snapshot,
            });
            if (error) throw dbError(error);
            return data ?? false;
        },
        getPerformedSet: async (setlistId) => {
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, name, status, event_id, performed_date, performed_snapshot",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl || sl.status !== "performed") return undefined;
            const snap = (sl.performed_snapshot ??
                null) as PerformedSnapshot | null;
            const ev = unwrap(
                await client
                    .from("event")
                    .select(
                        "name, event_date, per_song_seconds, per_set_seconds",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", sl.event_id)
                    .maybeSingle(),
            ) as Row | null;
            const items = (unwrap(
                await client
                    .from("setlist_item")
                    .select("song_id, note, transition_seconds")
                    .eq("ensemble_id", ens)
                    .eq("setlist_id", setlistId)
                    .eq("is_excluded", false)
                    .order("position"),
            ) ?? []) as Row[];
            const songIds = items.map((i) => i.song_id as string);
            // Prefer the frozen snapshot; fall back to live song reads for a set performed before it existed.
            let orderedSongs: SongRow[];
            if (snap) {
                orderedSongs = snap.songs;
            } else {
                const songRows = songIds.length
                    ? ((unwrap(
                          await client
                              .from("song")
                              .select(SONG_SELECT)
                              .eq("ensemble_id", ens)
                              .in("id", songIds),
                      ) ?? []) as Row[])
                    : [];
                const byId = new Map(
                    songRows.map((r) => [r.id as string, toSongRow(r)]),
                );
                orderedSongs = songIds
                    .map((id) => byId.get(id))
                    .filter((s): s is SongRow => s !== undefined);
            }
            const notes: Record<string, string> = {};
            const transitions: Record<string, number> = {};
            for (const i of items) {
                if (i.note) notes[i.song_id] = i.note;
                if (
                    i.transition_seconds !== null &&
                    i.transition_seconds !== undefined
                )
                    transitions[i.song_id] = i.transition_seconds;
            }
            const breaks = (
                (unwrap(
                    await client
                        .from("setlist_break")
                        .select("id, label, duration_seconds, after_position")
                        .eq("ensemble_id", ens)
                        .eq("setlist_id", setlistId)
                        .order("after_position"),
                ) ?? []) as Row[]
            ).map((b) => ({
                id: b.id,
                label: b.label,
                durationSeconds: b.duration_seconds,
                afterPosition: b.after_position,
            }));
            return {
                setlistId,
                setlistPublicId: sl.public_id,
                eventId: sl.event_id,
                eventName: snap?.eventName ?? ev?.name ?? "Event",
                name: sl.name,
                // The frozen performed date; event_date only for rows performed before the column.
                date: sl.performed_date ?? ev?.event_date ?? "",
                songs: orderedSongs,
                notes,
                transitions,
                breaks,
                padding:
                    snap?.padding ??
                    (ev
                        ? {
                              perSongSeconds: ev.per_song_seconds,
                              perSetSeconds: ev.per_set_seconds,
                          }
                        : { ...DEFAULT_PADDING }),
            };
        },
        getPublishedSet: async (setlistId) => {
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, name, status, event_id, performed_date, published_at, published_order, performed_snapshot",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl) return undefined;
            const performed = sl.status === "performed";
            const published =
                sl.published_at != null && sl.published_order != null;
            // Member-visible only when performed or published; a live draft returns nothing here. The
            // setlist row-level-security policy enforces the same, so this is the app-layer half of that gate.
            if (!performed && !published) return undefined;
            // A performed set uses its frozen snapshot (immutable history); a published-not-performed
            // set is still editable, so its songs and padding read live.
            const perfSnap = performed
                ? ((sl.performed_snapshot ?? null) as PerformedSnapshot | null)
                : null;

            const ev = unwrap(
                await client
                    .from("event")
                    .select(
                        "name, event_date, per_song_seconds, per_set_seconds",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", sl.event_id)
                    .maybeSingle(),
            ) as Row | null;

            // Frozen order source: a performed set reads its setlist_item positions; a published-not-yet-
            // performed set reads the jsonb snapshot the publish route captured.
            let songIds: string[];
            let rawTransitions: Record<string, number>;
            let breaks: {
                id: string;
                label: string;
                durationSeconds: number;
                afterPosition: number;
            }[];
            if (performed) {
                const items = (unwrap(
                    await client
                        .from("setlist_item")
                        .select("song_id, transition_seconds")
                        .eq("ensemble_id", ens)
                        .eq("setlist_id", setlistId)
                        .eq("is_excluded", false)
                        .order("position"),
                ) ?? []) as Row[];
                songIds = items.map((i) => i.song_id as string);
                rawTransitions = {};
                for (const i of items)
                    if (
                        i.transition_seconds !== null &&
                        i.transition_seconds !== undefined
                    )
                        rawTransitions[i.song_id] = i.transition_seconds;
                breaks = (
                    (unwrap(
                        await client
                            .from("setlist_break")
                            .select(
                                "id, label, duration_seconds, after_position",
                            )
                            .eq("ensemble_id", ens)
                            .eq("setlist_id", setlistId)
                            .order("after_position"),
                    ) ?? []) as Row[]
                ).map((b) => ({
                    id: b.id,
                    label: b.label,
                    durationSeconds: b.duration_seconds,
                    afterPosition: b.after_position,
                }));
            } else {
                const snap = (sl.published_order ?? {}) as {
                    songIds?: string[];
                    transitions?: Record<string, number>;
                    breaks?: {
                        id: string;
                        label: string;
                        durationSeconds: number;
                        afterPosition: number;
                    }[];
                };
                songIds = snap.songIds ?? [];
                rawTransitions = snap.transitions ?? {};
                breaks = snap.breaks ?? [];
            }

            let orderedSongs: SongRow[];
            if (perfSnap) {
                orderedSongs = perfSnap.songs;
            } else {
                const songRows = songIds.length
                    ? ((unwrap(
                          await client
                              .from("song")
                              .select(SONG_SELECT)
                              .eq("ensemble_id", ens)
                              .in("id", songIds),
                      ) ?? []) as Row[])
                    : [];
                const byId = new Map(
                    songRows.map((r) => [r.id as string, toSongRow(r)]),
                );
                orderedSongs = songIds
                    .map((id) => byId.get(id))
                    .filter((s): s is SongRow => s !== undefined);
            }

            // Notes read live, scoped to the order (frozen at perform for a performed set, current otherwise).
            const noteRows = songIds.length
                ? ((unwrap(
                      await client
                          .from("setlist_item")
                          .select("song_id, note")
                          .eq("ensemble_id", ens)
                          .eq("setlist_id", setlistId)
                          .in("song_id", songIds),
                  ) ?? []) as Row[])
                : [];
            const notes: Record<string, string> = {};
            for (const n of noteRows)
                if (n.note) notes[n.song_id as string] = n.note as string;

            const transitions: Record<string, number> = {};
            for (const id of songIds)
                if (rawTransitions[id] !== undefined)
                    transitions[id] = rawTransitions[id];

            return {
                setlistId,
                setlistPublicId: sl.public_id,
                eventId: sl.event_id,
                eventName: perfSnap?.eventName ?? ev?.name ?? "Event",
                name: sl.name,
                status: sl.status,
                performedDate: performed
                    ? ((sl.performed_date ?? ev?.event_date ?? null) as
                          | string
                          | null)
                    : null,
                songs: orderedSongs,
                notes,
                transitions,
                breaks,
                padding:
                    perfSnap?.padding ??
                    (ev
                        ? {
                              perSongSeconds: ev.per_song_seconds,
                              perSetSeconds: ev.per_set_seconds,
                          }
                        : { ...DEFAULT_PADDING }),
            };
        },
        getSharedDraft: async (setlistId) => {
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, name, status, event_id, published_at, share_draft, draft_order",
                    )
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl) return undefined;
            // A published or performed set reads through getPublishedSet (frozen); only a live, shared,
            // not-yet-published draft resolves here. The setlist_read RLS policy enforces the same member-
            // visibility gate (director, published, performed, OR share_draft); this is the app-layer half.
            if (sl.status === "performed" || sl.published_at != null)
                return undefined;
            if (!sl.share_draft || sl.draft_order == null) return undefined;
            const order = sl.draft_order as {
                songIds?: string[];
                transitions?: Record<string, number>;
                breaks?: {
                    id: string;
                    label: string;
                    durationSeconds: number;
                    afterPosition: number;
                }[];
            };
            const songIds = order.songIds ?? [];

            const ev = unwrap(
                await client
                    .from("event")
                    .select("name, per_song_seconds, per_set_seconds")
                    .eq("ensemble_id", ens)
                    .eq("id", sl.event_id)
                    .maybeSingle(),
            ) as Row | null;

            const songRows = songIds.length
                ? ((unwrap(
                      await client
                          .from("song")
                          .select(SONG_SELECT)
                          .eq("ensemble_id", ens)
                          .in("id", songIds),
                  ) ?? []) as Row[])
                : [];
            const byId = new Map(
                songRows.map((r) => [r.id as string, toSongRow(r)]),
            );
            const songs = songIds
                .map((id) => byId.get(id))
                .filter((s): s is SongRow => s !== undefined);

            const rawTransitions = order.transitions ?? {};
            const transitions: Record<string, number> = {};
            for (const id of songIds)
                if (rawTransitions[id] !== undefined)
                    transitions[id] = rawTransitions[id];

            // A draft's staging notes stay director-internal, so the member preview shows none.
            return {
                setlistId: sl.id,
                setlistPublicId: sl.public_id,
                eventId: sl.event_id,
                eventName: (ev?.name as string) ?? "Event",
                name: sl.name,
                status: sl.status,
                performedDate: null,
                songs,
                notes: {},
                transitions,
                breaks: order.breaks ?? [],
                padding: ev
                    ? {
                          perSongSeconds: ev.per_song_seconds,
                          perSetSeconds: ev.per_set_seconds,
                      }
                    : { ...DEFAULT_PADDING },
            };
        },
        cloneSetlist: async (sourceSetlistId, targetEventId) => {
            const ens = await activeEnsemble();
            // One transaction: create the draft + copy the frozen order as open/close/keep pins
            // (clone_setlist). Returns null when the source is not a performed set here / the target is gone.
            const newId = unwrap(
                await client.rpc("clone_setlist", {
                    p_ensemble: ens,
                    p_source: sourceSetlistId,
                    p_target_event: targetEventId,
                }),
            ) as string | null;
            if (!newId) return undefined;
            const row = unwrap(
                await client
                    .from("setlist")
                    .select("id, public_id, event_id, name, status")
                    .eq("ensemble_id", ens)
                    .eq("id", newId)
                    .single(),
            ) as Row;
            return {
                id: row.id,
                publicId: row.public_id,
                eventId: row.event_id,
                name: row.name,
                status: row.status,
                publishedAt: null,
                shareDraft: false,
            };
        },
        getSetlistHistory: async () => {
            const ens = await activeEnsemble();
            const sls = (unwrap(
                await client
                    .from("setlist")
                    .select(
                        "id, public_id, name, event_id, performed_date, performed_snapshot",
                    )
                    .eq("ensemble_id", ens)
                    .eq("status", "performed"),
            ) ?? []) as Row[];
            const out = [];
            for (const sl of sls) {
                const snap = (sl.performed_snapshot ??
                    null) as PerformedSnapshot | null;
                const ev = unwrap(
                    await client
                        .from("event")
                        .select("name, event_date")
                        .eq("ensemble_id", ens)
                        .eq("id", sl.event_id)
                        .maybeSingle(),
                ) as Row | null;
                // Frozen titles from the snapshot; fall back to live for a set performed before it existed.
                let titles: string[];
                if (snap) {
                    titles = snap.songs.map((s) => s.title);
                } else {
                    // setlist_item -> song is a composite FK, not embeddable by column; resolve titles
                    // with a separate lookup (as getPerformedSet does).
                    const items = (unwrap(
                        await client
                            .from("setlist_item")
                            .select("song_id")
                            .eq("ensemble_id", ens)
                            .eq("setlist_id", sl.id)
                            .eq("is_excluded", false)
                            .order("position"),
                    ) ?? []) as Row[];
                    const ids = items.map((i) => i.song_id as string);
                    const songRows = ids.length
                        ? ((unwrap(
                              await client
                                  .from("song")
                                  .select("id, title")
                                  .eq("ensemble_id", ens)
                                  .in("id", ids),
                          ) ?? []) as Row[])
                        : [];
                    const titleById = new Map(
                        songRows.map((s) => [
                            s.id as string,
                            s.title as string,
                        ]),
                    );
                    titles = ids.map((id) => titleById.get(id) ?? id);
                }
                out.push({
                    setlistId: sl.id,
                    setlistPublicId: sl.public_id,
                    eventId: sl.event_id,
                    eventName: snap?.eventName ?? ev?.name ?? "Event",
                    name: sl.name,
                    date: sl.performed_date ?? ev?.event_date ?? "",
                    titles,
                });
            }
            return out.sort((a, b) => b.date.localeCompare(a.date));
        },
        hydratePayload: async (eventId) => {
            const { data, error } = await client.rpc("hydrate_draft_input", {
                p_event: eventId,
            });
            if (error) throw dbError(error);
            // The RPC returns event:null for a missing/invisible event; the mock returns null.
            return data?.event ? data : null;
        },

        // --- Setlist items (notes / segues / breaks) -------------------------------
        setItemNote: async (setlistId, songId, note) => {
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select("ensemble_id")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl) return false;
            // set_item_field locks + merges in one transaction, so a concurrent segue edit isn't clobbered.
            unwrap(
                await client.rpc("set_item_field", {
                    p_setlist: setlistId,
                    p_song: songId,
                    p_field: "note",
                    p_note: note || null,
                    p_seconds: null,
                }),
            );
            return true;
        },
        getItemNotes: async (setlistId, songIds) => {
            if (songIds.length === 0) return {};
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("setlist_item")
                    .select("song_id, note")
                    .eq("ensemble_id", ens)
                    .eq("setlist_id", setlistId)
                    .in("song_id", songIds)
                    .not("note", "is", null),
            ) ?? []) as Row[];
            const out: Record<string, string> = {};
            for (const r of rows) if (r.note) out[r.song_id] = r.note;
            return out;
        },
        setTransition: async (setlistId, songId, seconds) => {
            const ens = await activeEnsemble();
            const sl = unwrap(
                await client
                    .from("setlist")
                    .select("ensemble_id")
                    .eq("ensemble_id", ens)
                    .eq("id", setlistId)
                    .maybeSingle(),
            ) as Row | null;
            if (!sl) return false;
            unwrap(
                await client.rpc("set_item_field", {
                    p_setlist: setlistId,
                    p_song: songId,
                    p_field: "transition",
                    p_note: null,
                    p_seconds: seconds,
                }),
            );
            return true;
        },
        getTransitions: async (setlistId, songIds) => {
            if (songIds.length === 0) return {};
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("setlist_item")
                    .select("song_id, transition_seconds")
                    .eq("ensemble_id", ens)
                    .eq("setlist_id", setlistId)
                    .in("song_id", songIds)
                    .not("transition_seconds", "is", null),
            ) ?? []) as Row[];
            const out: Record<string, number> = {};
            for (const r of rows)
                if (
                    r.transition_seconds !== null &&
                    r.transition_seconds !== undefined
                )
                    out[r.song_id] = r.transition_seconds;
            return out;
        },
        setBreaks: async (setlistId, breaks, expectedVersion) => {
            if (!(await ownedInEnsemble("setlist", setlistId)))
                return { ok: false, reason: "not_found" };
            const out = unwrap(
                await client.rpc("set_breaks", {
                    p_setlist: setlistId,
                    p_expected: expectedVersion,
                    p_rows: breaks,
                }),
            ) as WriteRpc;
            return fromWriteRpc(out);
        },
        getBreaks: async (setlistId) => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("setlist_break")
                    .select("id, label, duration_seconds, after_position")
                    .eq("ensemble_id", ens)
                    .eq("setlist_id", setlistId)
                    .order("after_position"),
            ) ?? []) as Row[];
            return rows.map((b) => ({
                id: b.id,
                label: b.label,
                durationSeconds: b.duration_seconds,
                afterPosition: b.after_position,
            }));
        },

        // --- Members ---------------------------------------------------------------
        listMembers: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("member")
                    .select("id, display_name")
                    .eq("ensemble_id", ens)
                    .eq("status", "active")
                    .eq("is_singing", true)
                    .order("created_at"),
            ) ?? []) as Row[];
            return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
        },
        listRoster: async () => {
            const ens = await activeEnsemble();
            // Paged: a roster over 1000 members would otherwise be truncated (id tiebreak keeps stable pages).
            const rows = await selectAll((from, to) =>
                client
                    .from("member")
                    .select(MEMBER_SELECT)
                    .eq("ensemble_id", ens)
                    .order("created_at")
                    .order("id")
                    .range(from, to),
            );
            return rows.map(toMemberRow);
        },
        getMember: async (id) =>
            getMemberById(client, await activeEnsemble(), id),
        createMember: async (input) => {
            const ensemble_id = await activeEnsemble();
            // One transaction: insert the member + its sections (save_member). A failed sections write
            // used to strand a member with none.
            const id = unwrap(
                await client.rpc("save_member", {
                    p_ensemble: ensemble_id,
                    p_member: null,
                    p_data: memberData(input),
                    p_sections: memberSections(input),
                    p_prune: false,
                }),
            ) as string;
            return (await getMemberById(client, ensemble_id, id))!;
        },
        updateMember: async (id, input) => {
            const ensemble_id = await activeEnsemble();
            const existing = await getMemberById(client, ensemble_id, id);
            if (!existing) return { ok: false, reason: "not-found" };
            if (
                existing.status === "active" &&
                existing.role === "director" &&
                input.role !== "director" &&
                (await activeDirectorsExcluding(client, ensemble_id, id)) === 0
            ) {
                return { ok: false, reason: "last-director" };
            }
            // One transaction: update the member, replace its sections, and (if they stopped singing)
            // prune their coverage — save_member does all three or none.
            const updated = unwrap(
                await client.rpc("save_member", {
                    p_ensemble: ensemble_id,
                    p_member: id,
                    p_data: memberData(input),
                    p_sections: memberSections(input),
                    p_prune: existing.singing && !input.singing,
                }),
            );
            if (!updated) return { ok: false, reason: "not-found" };
            return {
                ok: true,
                member: (await getMemberById(client, ensemble_id, id))!,
            };
        },
        setMemberStatus: async (id, status) => {
            const ensemble_id = await activeEnsemble();
            const existing = await getMemberById(client, ensemble_id, id);
            if (!existing) return { ok: false, reason: "not-found" };
            if (
                status === "inactive" &&
                existing.status === "active" &&
                existing.role === "director" &&
                (await activeDirectorsExcluding(client, ensemble_id, id)) === 0
            ) {
                return { ok: false, reason: "last-director" };
            }
            // One transaction: set the status and, on deactivation, prune coverage.
            const ok = unwrap(
                await client.rpc("set_member_status", {
                    p_ensemble: ensemble_id,
                    p_member: id,
                    p_status: status,
                }),
            );
            if (!ok) return { ok: false, reason: "not-found" };
            return {
                ok: true,
                member: (await getMemberById(client, ensemble_id, id))!,
            };
        },
        inviteMember: async (id, email, tokenHash) => {
            const ensemble_id = await activeEnsemble();
            const normalized = email.trim().toLowerCase();
            // Dead-end pre-check: if this email already belongs to a CLAIMED seat here (a user_id-bound
            // member), an invite can never bind — accept_invitation refuses a second seat per user, so it
            // would pend forever. Steer the director to reactivate that seat instead. ensemble_seat_for_email
            // is director-gated and reads auth.users to resolve the email -> seat that a plain query cannot.
            const seatRows = (unwrap(
                await client.rpc("ensemble_seat_for_email", {
                    p_ensemble: ensemble_id,
                    p_email: normalized,
                }),
            ) ?? []) as Row[];
            const seat = seatRows[0];
            if (seat && (seat.member_id as string) !== id) {
                return seat.member_status === "active"
                    ? {
                          ok: false,
                          reason: "already_member",
                          memberName:
                              (seat.display_name as string) ?? "a member",
                      }
                    : {
                          ok: false,
                          reason: "removed_member",
                          memberName:
                              (seat.display_name as string) ?? "a member",
                      };
            }
            // Invite state lives in the director-only member_invite side table. One pending seat
            // per email per ensemble (member_invite_one_per_email) — pre-check another seat for a friendly
            // message; the unique index is the real backstop.
            const dupe = (unwrap(
                await client
                    .from("member_invite")
                    .select("member_id")
                    .eq("ensemble_id", ensemble_id)
                    .eq("invite_email", normalized)
                    .neq("member_id", id),
            ) ?? []) as Row[];
            if (dupe.length > 0) return { ok: false, reason: "duplicate" };
            // Only an UNCLAIMED seat can be (re)invited: verify the member is in this ensemble and has no
            // account yet before recording the invite. (member lives on, so the user_id gate reads there.)
            const cur = unwrap(
                await client
                    .from("member")
                    .select("id, user_id")
                    .eq("ensemble_id", ensemble_id)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!cur) return { ok: false, reason: "not_found" };
            if (cur.user_id) return { ok: false, reason: "claimed" };
            // Record/refresh the invite. RLS (member_invite_write) gates this to the director; a non-director's
            // upsert violates the with-check, which surfaces as Postgres 42501. Return the clean forbidden
            // result the contract promises (matching the old zero-row UPDATE and the mock) rather than
            // throwing. invite_token_hash is the sha256 of the secret the invitee would present; dormant.
            const { data: rows, error: upsertErr } = await client
                .from("member_invite")
                .upsert(
                    {
                        ensemble_id,
                        member_id: id,
                        invite_email: normalized,
                        invited_at: new Date().toISOString(),
                        invite_token_hash: tokenHash,
                    },
                    { onConflict: "member_id" },
                )
                .select("member_id");
            if (upsertErr) {
                if (upsertErr.code === "42501")
                    return { ok: false, reason: "forbidden" }; // RLS denied a non-director
                // Two directors invited the same email between the pre-check above and this upsert: the
                // member_invite_one_per_email unique index (23505) is the real backstop. Map it to the same
                // friendly 'duplicate' the sequential pre-check returns instead of a raw 500.
                if (upsertErr.code === "23505")
                    return { ok: false, reason: "duplicate" };
                throw dbError(upsertErr);
            }
            return (rows ?? []).length > 0
                ? { ok: true }
                : { ok: false, reason: "forbidden" };
        },
        updateMyProfile: async (memberId, input) => {
            const ensemble_id = await activeEnsemble();
            // The RPC updates only the caller's own active member row (m.user_id = auth.uid());
            // a non-self memberId silently no-ops, so callers pass their own (resolved server-side).
            unwrap(
                await client.rpc("update_my_profile", {
                    p_member: memberId,
                    p_display_name: input.displayName,
                    p_range_low: input.rangeLowMidi,
                    p_range_high: input.rangeHighMidi,
                }),
            );
            return (await getMemberById(client, ensemble_id, memberId)) ?? null;
        },

        // --- Tags ------------------------------------------------------------------
        listTags: async () => {
            const ens = await activeEnsemble();
            const rows = await selectAll((from, to) =>
                client
                    .from("tag")
                    .select("*")
                    .eq("ensemble_id", ens)
                    .order("sort_order")
                    .order("created_at")
                    .order("id")
                    .range(from, to),
            );
            return rows.map(toTagRow);
        },
        tagUsage: async () => {
            const ens = await activeEnsemble();
            const tags = (unwrap(
                await client.from("tag").select("id").eq("ensemble_id", ens),
            ) ?? []) as Row[];
            const out: Record<
                string,
                { songs: number; events: number; eventTypes: number }
            > = {};
            for (const t of tags)
                out[t.id] = { songs: 0, events: 0, eventTypes: 0 };
            // Paged by each join table's PK: song_tag alone can far exceed 1000 rows in a real book, and a
            // truncated read would undercount usage (which gates whether a tag is safe to delete).
            const songTags = await selectAll((from, to) =>
                client
                    .from("song_tag")
                    .select("tag_id")
                    .eq("ensemble_id", ens)
                    .order("song_id")
                    .order("tag_id")
                    .range(from, to),
            );
            for (const r of songTags)
                if (out[r.tag_id]) out[r.tag_id]!.songs += 1;
            // event_tag / event_type_tag are one row per (entity, tag), so a count is already
            // a distinct-entity count.
            const eventTags = await selectAll((from, to) =>
                client
                    .from("event_tag")
                    .select("tag_id")
                    .eq("ensemble_id", ens)
                    .order("event_id")
                    .order("tag_id")
                    .range(from, to),
            );
            for (const r of eventTags)
                if (out[r.tag_id]) out[r.tag_id]!.events += 1;
            const etTags = await selectAll((from, to) =>
                client
                    .from("event_type_tag")
                    .select("tag_id")
                    .eq("ensemble_id", ens)
                    .order("event_type_id")
                    .order("tag_id")
                    .range(from, to),
            );
            for (const r of etTags)
                if (out[r.tag_id]) out[r.tag_id]!.eventTypes += 1;
            return out;
        },
        createTag: async (input) => {
            const ensemble_id = await activeEnsemble();
            const sort_order = await nextSortOrder(client, "tag", ensemble_id);
            const { data, error } = await client
                .from("tag")
                .insert({
                    ensemble_id,
                    name: input.name,
                    category: input.category,
                    sort_order,
                })
                .select("*")
                .single();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            return { ok: true, tag: toTagRow(data) };
        },
        updateTag: async (id, input) => {
            const ens = await activeEnsemble();
            const { data, error } = await client
                .from("tag")
                .update({ name: input.name, category: input.category })
                .eq("ensemble_id", ens)
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            if (!data) return { ok: false, reason: "not-found" };
            return { ok: true, tag: toTagRow(data) };
        },
        deleteTag: async (id) => {
            const ens = await activeEnsemble();
            const tag = unwrap(
                await client
                    .from("tag")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!tag) return { ok: false, reason: "not-found" };
            // Counts before the delete; the song_tag / event_tag / event_type_tag rows cascade.
            const songs =
                (
                    await client
                        .from("song_tag")
                        .select("song_id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("tag_id", id)
                ).count ?? 0;
            const events =
                (
                    await client
                        .from("event_tag")
                        .select("event_id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("tag_id", id)
                ).count ?? 0;
            const eventTypes =
                (
                    await client
                        .from("event_type_tag")
                        .select("event_type_id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("tag_id", id)
                ).count ?? 0;
            unwrap(
                await client
                    .from("tag")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            );
            return {
                ok: true,
                removedFromSongs: songs,
                removedFromEvents: events,
                removedFromEventTypes: eventTypes,
            };
        },
        reorderTags: async (orderedIds) =>
            void unwrap(
                await client.rpc("reorder_vocab", {
                    p_ensemble: await activeEnsemble(),
                    p_table: "tag",
                    p_ids: orderedIds,
                }),
            ),

        // --- Voice parts -----------------------------------------------------------
        listVoiceParts: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("voice_part")
                    .select("*")
                    .eq("ensemble_id", ens)
                    .order("sort_order")
                    .order("created_at")
                    .order("id"),
            ) ?? []) as Row[];
            return rows.map(toVoicePartRow);
        },
        voicePartUsage: async () => {
            const ens = await activeEnsemble();
            const vps = (unwrap(
                await client
                    .from("voice_part")
                    .select("id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            const out: Record<string, { parts: number; members: number }> = {};
            for (const v of vps) out[v.id] = { parts: 0, members: 0 };
            const partRows = (unwrap(
                await client
                    .from("part")
                    .select("voice_part_id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            for (const r of partRows)
                if (r.voice_part_id && out[r.voice_part_id])
                    out[r.voice_part_id]!.parts += 1;
            const mvp = (unwrap(
                await client
                    .from("member_voice_part")
                    .select("voice_part_id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            for (const r of mvp)
                if (out[r.voice_part_id]) out[r.voice_part_id]!.members += 1;
            return out;
        },
        createVoicePart: async (input) => {
            const ensemble_id = await activeEnsemble();
            const sort_order = await nextSortOrder(
                client,
                "voice_part",
                ensemble_id,
            );
            const { data, error } = await client
                .from("voice_part")
                .insert({
                    ensemble_id,
                    label: input.label,
                    sort_order,
                    is_pitched: input.isPitched,
                    nominal_low: input.nominalLowMidi,
                    nominal_high: input.nominalHighMidi,
                })
                .select("*")
                .single();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            return { ok: true, voicePart: toVoicePartRow(data) };
        },
        updateVoicePart: async (id, input) => {
            const ens = await activeEnsemble();
            const { data, error } = await client
                .from("voice_part")
                .update({
                    label: input.label,
                    is_pitched: input.isPitched,
                    nominal_low: input.nominalLowMidi,
                    nominal_high: input.nominalHighMidi,
                })
                .eq("ensemble_id", ens)
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            if (!data) return { ok: false, reason: "not-found" };
            return { ok: true, voicePart: toVoicePartRow(data) };
        },
        deleteVoicePart: async (id) => {
            const ens = await activeEnsemble();
            const vp = unwrap(
                await client
                    .from("voice_part")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!vp) return { ok: false, reason: "not-found" };
            // A section a chart still calls for cannot be deleted (part.voice_part_id is NO
            // ACTION); member links cascade. Pre-check parts to give the named reason.
            const partCount =
                (
                    await client
                        .from("part")
                        .select("id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("voice_part_id", id)
                ).count ?? 0;
            if (partCount > 0)
                return { ok: false, reason: "in-use", partCount };
            const removedMemberships =
                (
                    await client
                        .from("member_voice_part")
                        .select("member_id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("voice_part_id", id)
                ).count ?? 0;
            unwrap(
                await client
                    .from("voice_part")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            );
            return { ok: true, removedMemberships };
        },
        reorderVoiceParts: async (orderedIds) =>
            void unwrap(
                await client.rpc("reorder_vocab", {
                    p_ensemble: await activeEnsemble(),
                    p_table: "voice_part",
                    p_ids: orderedIds,
                }),
            ),

        // --- Padding profiles ------------------------------------------------------
        listPaddingProfiles: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("padding_profile")
                    .select("*")
                    .eq("ensemble_id", ens)
                    .order("created_at"),
            ) ?? []) as Row[];
            return rows.map(toPaddingProfileRow);
        },
        paddingProfileUsage: async () => {
            const ens = await activeEnsemble();
            const pps = (unwrap(
                await client
                    .from("padding_profile")
                    .select("id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            const out: Record<string, { eventTypes: number }> = {};
            for (const p of pps) out[p.id] = { eventTypes: 0 };
            const types = (unwrap(
                await client
                    .from("event_type")
                    .select("padding_profile_id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            for (const t of types)
                if (t.padding_profile_id && out[t.padding_profile_id])
                    out[t.padding_profile_id]!.eventTypes += 1;
            return out;
        },
        createPaddingProfile: async (input) => {
            const ensemble_id = await activeEnsemble();
            const { data, error } = await client
                .from("padding_profile")
                .insert({
                    ensemble_id,
                    name: input.name,
                    per_song_seconds: input.perSongSeconds,
                    per_set_seconds: input.perSetSeconds,
                })
                .select("*")
                .single();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            return { ok: true, profile: toPaddingProfileRow(data) };
        },
        updatePaddingProfile: async (id, input) => {
            const ens = await activeEnsemble();
            const { data, error } = await client
                .from("padding_profile")
                .update({
                    name: input.name,
                    per_song_seconds: input.perSongSeconds,
                    per_set_seconds: input.perSetSeconds,
                })
                .eq("ensemble_id", ens)
                .eq("id", id)
                .select("*")
                .maybeSingle();
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            if (!data) return { ok: false, reason: "not-found" };
            return { ok: true, profile: toPaddingProfileRow(data) };
        },
        deletePaddingProfile: async (id) => {
            const ens = await activeEnsemble();
            const pp = unwrap(
                await client
                    .from("padding_profile")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!pp) return { ok: false, reason: "not-found" };
            // event_type.padding_profile_id is ON DELETE SET NULL; count the referrers first.
            const clearedFromTypes =
                (
                    await client
                        .from("event_type")
                        .select("id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("padding_profile_id", id)
                ).count ?? 0;
            unwrap(
                await client
                    .from("padding_profile")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            );
            return { ok: true, clearedFromTypes };
        },

        // --- Event types -----------------------------------------------------------
        listEventTypes: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("event_type")
                    .select(EVENT_TYPE_SELECT)
                    .eq("ensemble_id", ens)
                    .order("sort_order")
                    .order("created_at")
                    .order("id"),
            ) ?? []) as Row[];
            return rows.map(toEventTypeRow);
        },
        eventTypeUsage: async () => {
            const ens = await activeEnsemble();
            const types = (unwrap(
                await client
                    .from("event_type")
                    .select("id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            const out: Record<string, { events: number }> = {};
            for (const t of types) out[t.id] = { events: 0 };
            const evs = (unwrap(
                await client
                    .from("event")
                    .select("event_type_id")
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            for (const e of evs)
                if (e.event_type_id && out[e.event_type_id])
                    out[e.event_type_id]!.events += 1;
            return out;
        },
        resolveEventTypePreset: async (typeId) => {
            const ens = await activeEnsemble();
            const t = await getEventTypeById(client, ens, typeId);
            return t ? resolvePreset(client, ens, t) : undefined;
        },
        eventTypePresets: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("event_type")
                    .select(EVENT_TYPE_SELECT)
                    .eq("ensemble_id", ens)
                    .order("sort_order")
                    .order("created_at")
                    .order("id"),
            ) ?? []) as Row[];
            const out: Record<string, ResolvedEventTypePreset> = {};
            for (const row of rows) {
                const t = toEventTypeRow(row);
                out[t.id] = await resolvePreset(client, ens, t);
            }
            return out;
        },
        createEventType: async (input) => {
            const ensemble_id = await activeEnsemble();
            const sort_order = await nextSortOrder(
                client,
                "event_type",
                ensemble_id,
            );
            const padding_profile_id = await validProfileId(
                client,
                ensemble_id,
                input.paddingProfileId,
            );
            // One transaction: insert the type + its tag rules (save_event_type). A unique-name clash
            // surfaces as a duplicate error, mapped to the typed result.
            const { data, error } = await client.rpc("save_event_type", {
                p_ensemble: ensemble_id,
                p_type: null,
                p_data: {
                    name: input.name,
                    sort_order,
                    padding_profile_id,
                    default_allows_on_book: input.defaultAllowsOnBook,
                    default_allows_explicit: input.defaultAllowsExplicit,
                    default_allows_accompaniment:
                        input.defaultAllowsAccompaniment,
                },
                p_exclude: input.excludeTags,
                p_prefer: input.preferTags,
                p_require: input.requireTags,
            });
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            return {
                ok: true,
                eventType: (await getEventTypeById(
                    client,
                    ensemble_id,
                    data as string,
                ))!,
            };
        },
        updateEventType: async (id, input) => {
            const ensemble_id = await activeEnsemble();
            const existing = unwrap(
                await client
                    .from("event_type")
                    .select("id")
                    .eq("ensemble_id", ensemble_id)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!existing) return { ok: false, reason: "not-found" };
            const padding_profile_id = await validProfileId(
                client,
                ensemble_id,
                input.paddingProfileId,
            );
            const { error } = await client.rpc("save_event_type", {
                p_ensemble: ensemble_id,
                p_type: id,
                p_data: {
                    name: input.name,
                    padding_profile_id,
                    default_allows_on_book: input.defaultAllowsOnBook,
                    default_allows_explicit: input.defaultAllowsExplicit,
                    default_allows_accompaniment:
                        input.defaultAllowsAccompaniment,
                },
                p_exclude: input.excludeTags,
                p_prefer: input.preferTags,
                p_require: input.requireTags,
            });
            if (error) {
                if (isDup(error)) return { ok: false, reason: "duplicate" };
                throw dbError(error);
            }
            return {
                ok: true,
                eventType: (await getEventTypeById(client, ensemble_id, id))!,
            };
        },
        deleteEventType: async (id) => {
            const ens = await activeEnsemble();
            const et = unwrap(
                await client
                    .from("event_type")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!et) return { ok: false, reason: "not-found" };
            // event.event_type_id is ON DELETE SET NULL; the event keeps its snapshot.
            const untypedEvents =
                (
                    await client
                        .from("event")
                        .select("id", { count: "exact", head: true })
                        .eq("ensemble_id", ens)
                        .eq("event_type_id", id)
                ).count ?? 0;
            unwrap(
                await client
                    .from("event_type")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            );
            return { ok: true, untypedEvents };
        },
        reorderEventTypes: async (orderedIds) =>
            void unwrap(
                await client.rpc("reorder_vocab", {
                    p_ensemble: await activeEnsemble(),
                    p_table: "event_type",
                    p_ids: orderedIds,
                }),
            ),

        // --- Soloist history -------------------------------------------------------
        listSoloistAppearances: async () => {
            const ens = await activeEnsemble();
            // The song title and soloist name are read from the frozen snapshot columns, so a
            // part/song/member deleted after the performance never erases or rewrites history.
            const rows = (unwrap(
                await client
                    .from("performance_soloist")
                    .select(
                        "member_id, song_title, member_display_name, setlist_id",
                    )
                    .eq("ensemble_id", ens),
            ) ?? []) as Row[];
            if (rows.length === 0) return [];
            const sls = (unwrap(
                await client
                    .from("setlist")
                    .select("id, status, event_id, performed_date")
                    .eq("ensemble_id", ens)
                    .in("id", [...new Set(rows.map((r) => r.setlist_id))]),
            ) ?? []) as Row[];
            const slById = new Map(sls.map((s) => [s.id, s]));
            const evs = (unwrap(
                await client
                    .from("event")
                    .select("id, name, event_date")
                    .eq("ensemble_id", ens)
                    .in("id", [...new Set(sls.map((s) => s.event_id))]),
            ) ?? []) as Row[];
            const evById = new Map(evs.map((e) => [e.id, e]));
            const out = [];
            for (const r of rows) {
                const sl = slById.get(r.setlist_id);
                if (!sl || sl.status !== "performed") continue;
                const ev = evById.get(sl.event_id);
                out.push({
                    memberId: r.member_id,
                    displayName: r.member_display_name,
                    songTitle: r.song_title,
                    eventName: ev?.name ?? "Event",
                    date: sl.performed_date ?? ev?.event_date ?? "",
                });
            }
            return out;
        },

        // --- Playgrounds -----------------------------------------------------------
        listPlaygrounds: async () => {
            const ens = await activeEnsemble();
            const rows = (unwrap(
                await client
                    .from("program")
                    .select(PROGRAM_SELECT)
                    .eq("ensemble_id", ens)
                    .order("created_at"),
            ) ?? []) as Row[];
            return rows.map(toPlaygroundMeta);
        },
        getPlayground: async (id) =>
            getPlaygroundById(client, await activeEnsemble(), id),
        createPlayground: async (name) => {
            const ensemble_id = await activeEnsemble();
            const r = unwrap(
                await client
                    .from("program")
                    .insert({ ensemble_id, name })
                    .select(PROGRAM_SELECT)
                    .single(),
            ) as Row;
            return toPlaygroundMeta(r);
        },
        updatePlayground: async (id, patch) => {
            const ensemble_id = await activeEnsemble();
            const existing = await getPlaygroundById(client, ensemble_id, id);
            if (!existing) return undefined;
            const name = patch.name !== undefined ? patch.name : existing.name;
            const songIds =
                patch.songIds !== undefined ? patch.songIds : existing.songIds;
            let open = patch.open !== undefined ? patch.open : existing.open;
            let close =
                patch.close !== undefined ? patch.close : existing.close;
            // An anchor must be one of the program's songs, and one song cannot hold both ends.
            if (open !== null && !songIds.includes(open)) open = null;
            if (close !== null && (!songIds.includes(close) || close === open))
                close = null;
            // One transaction: rename (when provided) + replace the ordered items (save_program). The
            // old delete-then-insert wiped the program on a failed insert.
            unwrap(
                await client.rpc("save_program", {
                    p_program: id,
                    p_name: patch.name !== undefined ? name : null,
                    p_song_ids: songIds,
                    p_open: open,
                    p_close: close,
                }),
            );
            return getPlaygroundById(client, ensemble_id, id);
        },
        isPlaygroundAssigned: async (id) => {
            const ens = await activeEnsemble();
            const { count } = await client
                .from("setlist")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ens)
                .eq("program_id", id);
            return (count ?? 0) > 0;
        },
        deletePlayground: async (id) => {
            const ens = await activeEnsemble();
            const p = unwrap(
                await client
                    .from("program")
                    .select("id")
                    .eq("ensemble_id", ens)
                    .eq("id", id)
                    .maybeSingle(),
            ) as Row | null;
            if (!p) return { ok: false, reason: "not-found" };
            // setlist.program_id is ON DELETE RESTRICT: a program assigned to an event can't go.
            const { count } = await client
                .from("setlist")
                .select("id", { count: "exact", head: true })
                .eq("ensemble_id", ens)
                .eq("program_id", id);
            if ((count ?? 0) > 0) return { ok: false, reason: "assigned" };
            unwrap(
                await client
                    .from("program")
                    .delete()
                    .eq("ensemble_id", ens)
                    .eq("id", id),
            );
            return { ok: true };
        },
        createSetlistFromPlayground: async (playgroundId, eventId) => {
            const ens = await activeEnsemble();
            // One transaction: create the draft + copy the program's order as open/close/keep pins
            // (create_setlist_from_program). The old insert-then-set-pins left a pin-less setlist on a
            // mid-sequence failure. Returns null when the program/event is not visible.
            const newId = unwrap(
                await client.rpc("create_setlist_from_program", {
                    p_ensemble: ens,
                    p_program: playgroundId,
                    p_event: eventId,
                }),
            ) as string | null;
            if (!newId) return undefined;
            const row = unwrap(
                await client
                    .from("setlist")
                    .select("id, public_id, event_id, name, status")
                    .eq("ensemble_id", ens)
                    .eq("id", newId)
                    .single(),
            ) as Row;
            return {
                id: row.id,
                publicId: row.public_id,
                eventId: row.event_id,
                name: row.name,
                status: row.status,
                publishedAt: null,
                shareDraft: false,
            };
        },
    };
}
