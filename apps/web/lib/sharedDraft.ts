// The order snapshot captured from a live draft: the song ids in order, the segues scoped to those
// songs, and the breaks clamped into range. Publish stores this shape in published_order and sharing
// stores it in draft_order; both then refresh as the director edits (until the set is performed, which
// freezes it for good). One place, so the two never drift.

import { normalizeBreaks, songsOf } from "@repertoire/core";
import { loadSetlist } from "./setlist";
import type { Repository } from "./repository";
import type { SetlistStatus } from "./db";
import type { SetlistDraftPayload } from "./types";

export interface DraftSnapshot {
    songIds: string[];
    transitions: Record<string, number>;
    breaks: SetlistDraftPayload["breaks"];
}

export function draftSnapshot(payload: SetlistDraftPayload): DraftSnapshot {
    const songIds = songsOf(payload.draft.set).map((e) => e.song.id);
    const inOrder = new Set(songIds);
    const transitions: Record<string, number> = {};
    for (const [id, gap] of Object.entries(payload.transitions)) {
        if (inOrder.has(id)) transitions[id] = gap;
    }
    const breaks = normalizeBreaks(payload.breaks, songIds.length);
    return { songIds, transitions, breaks };
}

// Which member-visible snapshots to refresh after an order-changing edit. A performed set is an
// immutable record, so it is never refreshed. A published set and a shared draft are DISTINCT member
// read paths and can both be live at once (a director can share a draft and then publish it — the
// Publish button stays enabled while sharing, and once published the Share toggle is hidden, so
// share_draft can be stuck on). Published wins the live read (loadFrozenSnapshot / buildCallSheetView
// read getPublishedSet first), but the shared draft is the fallback a member reads if the set is later
// unpublished — so BOTH must stay current, or unpublishing exposes a stale order. Pure, so the matrix
// is unit-tested without spinning up the drafter.
export function memberSnapshotTargets(meta: {
    status: SetlistStatus;
    publishedAt: string | null;
    shareDraft: boolean;
}): Array<"published" | "shared"> {
    if (meta.status === "performed") return [];
    const targets: Array<"published" | "shared"> = [];
    if (meta.publishedAt != null) targets.push("published");
    if (meta.shareDraft) targets.push("shared");
    return targets;
}

// Refresh a set's member-visible order after an order-changing edit, so what members see tracks what
// the director sees. Refreshes EVERY live member snapshot (see memberSnapshotTargets): a published set,
// a shared draft, or both. Skips the re-draft entirely when nothing is member-visible. Always snapshots
// the CANONICAL draft (no variety), never a transient re-generate, so members follow the director's
// committed set. Safe to await and best-effort — a sync failure must never fail the underlying edit, so
// callers ignore its result.
export async function resyncMemberSnapshot(
    repo: Repository,
    setlistId: string,
): Promise<void> {
    const meta = await repo.getSetlistMeta(setlistId);
    if (!meta) return;
    const targets = memberSnapshotTargets(meta);
    if (targets.length === 0) return;
    const loaded = await loadSetlist(repo, setlistId);
    if (loaded.status !== 200) return;
    const snapshot = draftSnapshot(loaded.body);
    // Each repo method is independently guarded, but memberSnapshotTargets already told us which apply,
    // so this only issues the writes that will land.
    if (targets.includes("published"))
        await repo.syncPublishedOrder(setlistId, snapshot);
    if (targets.includes("shared"))
        await repo.syncSharedDraftOrder(setlistId, snapshot);
}

// Refresh every member-visible set of an event after an edit that can shift its drafts' order — a prep
// change (which songs the drafter prefers) or an event-detail change (target length, padding,
// context tags, book/explicit policy all feed the funnel). Covers both published and shared sets.
// Fully best-effort: the whole body is guarded, so neither the setlist listing nor a per-set resync
// can fail the underlying edit.
export async function resyncEventMemberSnapshots(
    repo: Repository,
    eventId: string,
): Promise<void> {
    try {
        for (const sl of await repo.listEventSetlists(eventId)) {
            if (
                sl.status !== "performed" &&
                (sl.publishedAt != null || sl.shareDraft)
            ) {
                await resyncMemberSnapshot(repo, sl.id).catch(() => {});
            }
        }
    } catch {
        /* best-effort: a resync failure must never fail the underlying edit */
    }
}
