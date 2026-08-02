"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    songsOf,
    type Seam,
    type SetBreak,
    type SetEntry,
    type VarietyConfig,
} from "@repertoire/core";
import type { PinState, SetlistDraftPayload, UnplacedPrep } from "@/lib/types";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { TimingBar } from "./TimingBar";
import { SetRail } from "./SetRail";
import { BalanceArc } from "./BalanceArc";
import { EditableSetList } from "./EditableSetList";
import { NotInSet } from "./NotInSet";

// Drop a value from a list, dedupe-safe.
const without = (list: string[], id: string) => list.filter((x) => x !== id);
const withId = (list: string[], id: string) =>
    list.includes(id) ? list : [...list, id];
const keyOf = (ids: string[]) => ids.join("|");
const varietyLabel = (a: number) =>
    a <= 0 ? "off" : a <= 1.5 ? "subtle" : a <= 3.5 ? "medium" : "wild";

// Refcounted in-flight markers. A field can have more than one save overlapping, so retain/release
// by count and clear the marker only when the LAST write settles. A plain delete would clear it while
// another write is still pending, letting a concurrent re-draft's adopt overwrite the optimistic value.
const retain = (m: Map<string, number>, id: string) =>
    m.set(id, (m.get(id) ?? 0) + 1);
const release = (m: Map<string, number>, id: string) => {
    const n = (m.get(id) ?? 0) - 1;
    if (n <= 0) m.delete(id);
    else m.set(id, n);
};

function unplacedReason(it: UnplacedPrep): string {
    if (it.reason === "cast") {
        return it.shortParts && it.shortParts.length > 0
            ? `Can't cast: ${it.shortParts.join(", ")}`
            : "Can't cast";
    }
    if (it.reason === "room") return "No room in the set";
    return "No length set";
}

// Committed prep songs the draft could not place. Prep is preferred, not forced, so an uncastable
// or over-budget commitment benches instead of distorting the set. Surface it plainly, above the
// set, so the director can recast, trim, or swap in a replacement.
function UnplacedPrepNotice({ items }: { items: UnplacedPrep[] }) {
    if (items.length === 0) return null;
    return (
        <aside className="unplaced-prep" role="status" aria-live="polite">
            <p className="unplaced-prep-head">
                Committed to this gig, not in the draft
            </p>
            <ul className="unplaced-prep-list">
                {items.map((it) => (
                    <li key={it.songId}>
                        <span className="unplaced-prep-title">{it.title}</span>
                        <span className="unplaced-prep-reason">
                            {unplacedReason(it)}
                        </span>
                    </li>
                ))}
            </ul>
            <p className="unplaced-prep-hint">
                Recast, trim the set, or add a replacement from Not in the set.
            </p>
        </aside>
    );
}

// The director's setlist workspace for an event's draft: the editable running order with seams,
// timing, variety re-generate, per-song notes, and set breaks, alongside the not-in-set bench.
// Publishing freezes the order on screen as the shared record. `locked` renders it read-only once
// the set has been performed.
export function SetlistView({
    initial,
    setlistPublicId,
    locked = false,
    publishedAt = null,
    shareDraft = false,
    version,
}: {
    initial: SetlistDraftPayload;
    setlistPublicId: string; // the setlist URL token, for the print-sheet link (data reads use initial.setlistId)
    locked?: boolean;
    publishedAt?: string | null; // set when members can currently see this set
    shareDraft?: boolean; // sharing the LIVE draft with members (distinct from publish, which freezes)
    version: string;
}) {
    const initialIds = songsOf(initial.draft.set).map((e) => e.song.id);
    const [payload, setPayload] = useState(initial);
    const [order, setOrder] = useState<string[]>(initialIds);
    const [seams, setSeams] = useState<Seam[]>(initial.draft.seams);
    // The id order the current seams were computed for. Seams only render when it
    // matches the displayed order, so an in-flight recompute never paints stale
    // flags against the wrong adjacent pairs.
    const [seamsKey, setSeamsKey] = useState<string>(keyOf(initialIds));
    const [manual, setManual] = useState(false);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(
        null,
    );
    // Entropy lives behind Re-generate only. seed is null until the first
    // Re-generate, so the initial draft stays the deterministic optimum. amount is
    // the variety strength the director dials in.
    const [seed, setSeed] = useState<number | null>(null);
    const [amount, setAmount] = useState(2);
    const [notes, setNotes] = useState<Record<string, string>>(initial.notes);
    const [transitions, setTransitions] = useState<Record<string, number>>(
        initial.transitions,
    );
    const [breaks, setBreaksState] = useState<SetBreak[]>(initial.breaks);
    // Optimistic-concurrency token for break edits, advanced from each successful save.
    const [breaksToken, setBreaksToken] = useState(version);
    // The authoritative running-order clock (durations + segue gaps + break time + per-set
    // overhead), owned by core. Updated by every re-draft and every /seams re-cost.
    const [total, setTotal] = useState(initial.draft.totalSeconds);

    // Monotonic token. Every reorder and every re-draft bumps it; a /seams response
    // is applied only if its token is still current, so a late response from a
    // superseded order or a since-completed re-draft is ignored.
    const genRef = useRef(0);
    // Song ids with note / segue saves in flight (refcounted), protected from a concurrent re-draft's adopt.
    const pendingNotes = useRef<Map<string, number>>(new Map());
    const pendingTransitions = useRef<Map<string, number>>(new Map());
    // Per-field monotonic write sequence. A revert only fires if this call is still the latest write
    // for the field, so an older failed save can never clobber a newer successful optimistic value.
    const noteSeq = useRef<Map<string, number>>(new Map());
    const transitionSeq = useRef<Map<string, number>>(new Map());
    const router = useRouter();
    const prefix = useEnsemblePrefix();

    // Re-seed the break-edit token whenever the server hands down a fresh setlist version. A
    // publish / unpublish / finalize / perform / share action calls router.refresh(), which
    // re-renders this component with a new `version` prop; without re-seeding, breaksToken keeps
    // its mount-time value and the next break edit false-conflicts ("changed somewhere else").
    // `version` only moves forward (the server component re-reads the current row), so this never
    // reverts a fresher token a just-saved break already advanced past the prop.
    useEffect(() => {
        setBreaksToken(version);
    }, [version]);

    const setlistId = payload.setlistId;
    const pins = payload.pins;
    const draft = payload.draft;

    const bySong = useMemo(
        () =>
            new Map<string, SetEntry>(
                songsOf(draft.set).map((e) => [e.song.id, e]),
            ),
        [draft],
    );
    const titleOf = useCallback(
        (id: string) => payload.catalog.find((c) => c.id === id)?.title ?? id,
        [payload.catalog],
    );
    const metaOf = useCallback(
        (id: string) => payload.catalog.find((c) => c.id === id)?.meta ?? null,
        [payload.catalog],
    );
    // Song uuid -> URL token, for links that leave the app's data layer (the song deep link in
    // NotInSet, and the print sheet's ?order= param). Data reads keep using the uuids in `order`.
    const tokenById = useMemo(
        () => new Map(payload.catalog.map((c) => [c.id, c.publicId])),
        [payload.catalog],
    );

    const adopt = (p: SetlistDraftPayload) => {
        genRef.current += 1; // invalidate any in-flight seam recompute
        const ids = songsOf(p.draft.set).map((e) => e.song.id);
        setPayload(p);
        setOrder(ids);
        setSeams(p.draft.seams);
        setSeamsKey(keyOf(ids));
        setTotal(p.draft.totalSeconds);
        setBreaksState(p.breaks);
        // Keep any note still being saved over the re-draft's (possibly pre-edit) payload.
        setNotes((prev) => {
            const merged: Record<string, string> = { ...p.notes };
            for (const id of pendingNotes.current.keys()) {
                const local = prev[id];
                if (local) merged[id] = local;
                else delete merged[id];
            }
            return merged;
        });
        // Same for an in-flight segue change.
        setTransitions((prev) => {
            const merged: Record<string, number> = { ...p.transitions };
            for (const id of pendingTransitions.current.keys()) {
                const local = prev[id];
                if (local !== undefined) merged[id] = local;
                else delete merged[id];
            }
            return merged;
        });
        setManual(false);
        setStatus(null);
    };

    // Returns true when the re-draft was adopted, false when it failed (and set an error
    // status). Callers that show their own success message must check this first.
    const redraft = useCallback(
        async (
            next: PinState,
            variety: VarietyConfig | undefined,
        ): Promise<boolean> => {
            genRef.current += 1; // a re-draft supersedes any in-flight seam recompute
            setBusy(true);
            try {
                const res = await fetch(`/api${prefix}/setlist/${setlistId}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ pins: next, variety }),
                });
                const body = await res.json();
                if (res.ok) {
                    adopt(body as SetlistDraftPayload);
                    return true;
                }
                setStatus({
                    text: `Could not re-draft (${res.status}).`,
                    ok: false,
                });
                return false;
            } catch {
                setStatus({ text: "Could not reach the server.", ok: false });
                return false;
            } finally {
                setBusy(false);
            }
        },
        [setlistId],
    );

    // The variety in force now: none until Re-generate has rolled a seed, or when
    // the strength is at zero. Pin changes refine within the current take.
    const varietyNow = (): VarietyConfig | undefined =>
        seed === null || amount <= 0 ? undefined : { seed, amount };
    const applyPins = (next: PinState) => redraft(next, varietyNow());

    // Re-cost a given order (the non-authoritative seam + clock refresh) and adopt the result only if
    // it is still current. Shared by reorder, break edits, and segue edits; each of those owns its own
    // write + rollback, then calls this to refresh. A stale or failed recompute leaves the prior seams.
    const refreshSeams = useCallback(
        async (nextOrder: string[]) => {
            const gen = (genRef.current += 1);
            try {
                const res = await fetch(
                    `/api${prefix}/setlist/${setlistId}/seams`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ order: nextOrder }),
                    },
                );
                const body = await res.json();
                if (
                    gen === genRef.current &&
                    res.ok &&
                    Array.isArray(body.seams)
                ) {
                    setSeams(body.seams as Seam[]);
                    setSeamsKey(keyOf(nextOrder));
                    if (typeof body.totalSeconds === "number")
                        setTotal(body.totalSeconds);
                }
            } catch {
                /* keep the prior seams if the recompute fails */
            }
        },
        [prefix, setlistId],
    );

    // Persist the director's manual order (a drag / Auto-arrange), then adopt the re-cost if still
    // current. Unlike refreshSeams (a transient re-cost for segue/break edits), this WRITES the
    // arrangement, so it survives a reload and is what publish/share freeze. The persist bumps the
    // setlist version, so advance the break-edit token to the returned version (as breaks/transition do).
    const persistOrder = useCallback(
        async (nextOrder: string[]) => {
            const gen = (genRef.current += 1);
            try {
                const res = await fetch(
                    `/api${prefix}/setlist/${setlistId}/order`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ order: nextOrder }),
                    },
                );
                const body = await res.json();
                if (typeof body.version === "string")
                    setBreaksToken(body.version);
                if (
                    gen === genRef.current &&
                    res.ok &&
                    Array.isArray(body.seams)
                ) {
                    setSeams(body.seams as Seam[]);
                    setSeamsKey(keyOf(nextOrder));
                    if (typeof body.totalSeconds === "number")
                        setTotal(body.totalSeconds);
                }
            } catch {
                /* keep the prior seams if the persist/recompute fails; the next load reconciles */
            }
        },
        [prefix, setlistId],
    );

    // A break sits at an ordinal slot in the CURRENT (possibly hand-arranged) order, so write
    // the new break list then RE-COST that order (like a segue) rather than re-draft — a
    // re-draft would discard the hand-arrangement and re-interpret the slot against a
    // different sequence, landing the intermission where the director did not click. The
    // budget sizing around breaks happens on Re-generate / the next draft, where the order is
    // canonical anyway.
    const applyBreaks = async (next: SetBreak[]) => {
        const prev = breaks;
        setBreaksState(next);
        // The within-segment seams change but the order does not, so invalidate seamsKey until
        // the re-cost lands (a reorder does this implicitly via the order change).
        setSeamsKey("");
        setBusy(true);
        try {
            // 1) Write the breaks. A failed save OR an unreachable server reverts the optimistic change —
            // nothing was persisted, so keeping a phantom break until a reload would be a lie.
            try {
                const saved = await fetch(
                    `/api${prefix}/setlist/${setlistId}/breaks`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            breaks: next,
                            expectedVersion: breaksToken,
                        }),
                    },
                );
                const savedBody = (await saved.json().catch(() => ({}))) as {
                    version?: string;
                    error?: string;
                };
                if (!saved.ok) {
                    // Lost a concurrency race, or the set is now locked — undo the optimistic change.
                    setBreaksState(prev);
                    setSeamsKey(keyOf(order));
                    setStatus({
                        text:
                            savedBody.error ??
                            `Could not save breaks (${saved.status}).`,
                        ok: false,
                    });
                    return;
                }
                if (typeof savedBody.version === "string")
                    setBreaksToken(savedBody.version);
            } catch {
                setBreaksState(prev);
                setSeamsKey(keyOf(order));
                setStatus({
                    text: "Could not save breaks. The server was unreachable.",
                    ok: false,
                });
                return;
            }
            // 2) The breaks are SAVED; re-cost the order. A failure here just leaves the prior seams.
            await refreshSeams(order);
        } finally {
            setBusy(false);
        }
    };
    const addBreak = (afterPosition: number) =>
        applyBreaks([
            ...breaks,
            {
                id: crypto.randomUUID(),
                label: "Intermission",
                durationSeconds: 600,
                afterPosition,
            },
        ]);
    const removeBreak = (id: string) =>
        applyBreaks(breaks.filter((b) => b.id !== id));
    const editBreakDuration = (id: string, durationSeconds: number) =>
        applyBreaks(
            breaks.map((b) => (b.id === id ? { ...b, durationSeconds } : b)),
        );

    const reorder = useCallback(
        async (next: string[]) => {
            setOrder(next);
            setManual(true);
            // Persist the arrangement (not just re-cost), so it survives reload and is what publish/share
            // freeze — the whole point of the manual reorder.
            await persistOrder(next);
        },
        [persistOrder],
    );

    // Re-generate: roll a fresh seed and re-draft with the current variety
    // strength, discarding any manual hand-arrangement. At strength 0 this is the
    // deterministic canonical set; above 0 it offers a different but still-valid
    // pull. The seed sticks, so subsequent pin changes refine the same take.
    const regenerate = async () => {
        const next = Math.floor(Math.random() * 1_000_000_000);
        setSeed(next);
        const ok = await redraft(
            pins,
            amount > 0 ? { seed: next, amount } : undefined,
        );
        if (!ok) return; // redraft already surfaced the failure; don't claim success
        setStatus({
            text:
                amount > 0
                    ? "Re-generated a fresh take. Re-generate again for another."
                    : "Re-generated the canonical set (variety at zero).",
            ok: true,
        });
    };

    // Auto-arrange: re-sequence the songs already in the set (honoring the opener/closer
    // pins) without re-drafting, so nothing is swapped in or out. Adopts the returned
    // order/seams/total like a hand reorder; a pin change afterward still re-drafts.
    const autoArrange = async () => {
        const gen = (genRef.current += 1);
        setBusy(true);
        setStatus(null);
        try {
            const res = await fetch(
                `/api${prefix}/setlist/${setlistId}/arrange`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ order }),
                },
            );
            const body = await res.json();
            // Auto-arrange persists the arrangement server-side, which bumps the setlist version; advance
            // the break-edit token to it regardless of the stale-response gen check below.
            if (typeof body.version === "string") setBreaksToken(body.version);
            if (res.ok && Array.isArray(body.order)) {
                // Drop the response if a newer reorder or re-draft has happened since.
                if (gen === genRef.current) {
                    const next = body.order as string[];
                    const changed = keyOf(next) !== keyOf(order);
                    setOrder(next);
                    setSeams((body.seams as Seam[] | undefined) ?? []);
                    setSeamsKey(keyOf(next));
                    if (typeof body.totalSeconds === "number")
                        setTotal(body.totalSeconds);
                    // Only a real reordering is a departure from the draft worth flagging.
                    if (changed) setManual(true);
                    setStatus({
                        text: changed
                            ? "Auto-arranged. Drag to fine-tune."
                            : "Already in a smooth order.",
                        ok: true,
                    });
                }
            } else {
                setStatus({
                    text: `Could not auto-arrange (${res.status}).`,
                    ok: false,
                });
            }
        } catch {
            setStatus({ text: "Could not reach the server.", ok: false });
        } finally {
            setBusy(false);
        }
    };

    const onSetNote = useCallback(
        async (songId: string, note: string) => {
            const mySeq = (noteSeq.current.get(songId) ?? 0) + 1;
            noteSeq.current.set(songId, mySeq);
            // Optimistic: show the typed note immediately.
            setNotes((prev) => {
                const next = { ...prev };
                if (note) next[songId] = note;
                else delete next[songId];
                return next;
            });
            retain(pendingNotes.current, songId);
            // On a rejected save, KEEP the typed text on screen rather than reverting — discarding a
            // multi-sentence staging note would lose the director's work — but say plainly it was not
            // saved. Only the latest write for this field reports; a newer edit owns the field otherwise.
            const failed = (text: string) => {
                if (noteSeq.current.get(songId) === mySeq)
                    setStatus({ text, ok: false });
            };
            try {
                const res = await fetch(
                    `/api${prefix}/setlist/${setlistId}/note`,
                    {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ songId, note }),
                        keepalive: true, // survive an unmount or navigation mid-save
                    },
                );
                if (!res.ok) {
                    failed(
                        `Could not save the note (${res.status}). Your text is kept on screen but not saved.`,
                    );
                }
            } catch {
                failed(
                    "Could not save the note. The server was unreachable. Your text is kept on screen but not saved.",
                );
            } finally {
                release(pendingNotes.current, songId);
            }
        },
        [setlistId, prefix],
    );

    // Set or clear a segue (the gap leaving a song). Writes the override, then re-costs
    // the current order so the seam flags and the clock total reflect the new gap.
    const onSetTransition = useCallback(
        async (fromId: string, seconds: number | null) => {
            const prevSeconds = transitions[fromId]; // for an exact revert if the WRITE is rejected
            const mySeq = (transitionSeq.current.get(fromId) ?? 0) + 1;
            transitionSeq.current.set(fromId, mySeq);
            const revert = () => {
                if (transitionSeq.current.get(fromId) !== mySeq) return; // a newer write owns this field now
                setTransitions((prev) => {
                    const next = { ...prev };
                    if (prevSeconds !== undefined) next[fromId] = prevSeconds;
                    else delete next[fromId];
                    return next;
                });
            };
            setTransitions((prev) => {
                const next = { ...prev };
                if (seconds === null) delete next[fromId];
                else next[fromId] = seconds;
                return next;
            });
            // The gap changed but the order did not, so seamsKey would still match and keep
            // painting the pre-edit decay (the very warning an attacca is meant to change).
            // Invalidate it — as a reorder does implicitly — so the seam flags blank until the
            // re-cost returns the decay for the new gap. '' never equals a non-empty keyOf(order).
            setSeamsKey("");
            retain(pendingTransitions.current, fromId);
            try {
                // 1) Write the segue. Only a failed/unreachable WRITE reverts the optimistic value.
                try {
                    const wrote = await fetch(
                        `/api${prefix}/setlist/${setlistId}/transition`,
                        {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ songId: fromId, seconds }),
                        },
                    );
                    const wroteBody = (await wrote
                        .json()
                        .catch(() => ({}))) as { version?: string };
                    if (!wrote.ok) {
                        revert(); // rejected (locked set, validation) — don't keep a phantom segue
                        setSeamsKey(keyOf(order));
                        setStatus({
                            text: `Could not save the segue (${wrote.status}).`,
                            ok: false,
                        });
                        return;
                    }
                    // When the set is shared, saving a segue resyncs the members' copy, which bumps the
                    // setlist version. Advance the break-edit token to the returned version so a following
                    // break edit does not false-conflict against the resync's own bump.
                    if (typeof wroteBody.version === "string")
                        setBreaksToken(wroteBody.version);
                } catch {
                    revert();
                    setSeamsKey(keyOf(order));
                    setStatus({
                        text: "Could not save the segue. The server was unreachable.",
                        ok: false,
                    });
                    return;
                }
                // 2) The segue is SAVED; re-cost the order. A failure here must NOT revert the saved value —
                // just leave the prior seams (refreshSeams' own catch); a later reorder/reload reconciles them.
                await refreshSeams(order);
            } finally {
                release(pendingTransitions.current, fromId);
            }
        },
        [setlistId, order, transitions, refreshSeams],
    );

    const markPerformed = useCallback(async () => {
        setBusy(true);
        try {
            // Send the order on screen so the frozen record keeps a hand-arrangement.
            const res = await fetch(
                `/api${prefix}/setlist/${setlistId}/perform`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ order }),
                },
            );
            if (res.ok) {
                setStatus({
                    text: "Marked performed. The next draft will spread repetition.",
                    ok: true,
                });
                router.refresh(); // the page now renders the read-only performed set
            } else {
                setStatus({
                    text: `Could not mark performed (${res.status}).`,
                    ok: false,
                });
            }
        } catch {
            setStatus({
                text: "Could not mark performed. The server was unreachable.",
                ok: false,
            });
        } finally {
            setBusy(false);
        }
    }, [setlistId, order, router]);

    // Unlock a finalized set: flip its status back to draft, then re-render editable.
    const revertToDraft = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch(`/api${prefix}/setlist/${setlistId}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: "draft" }),
            });
            if (res.ok) router.refresh();
            else
                setStatus({
                    text: `Could not revert (${res.status}).`,
                    ok: false,
                });
        } catch {
            setStatus({
                text: "Could not revert. The server was unreachable.",
                ok: false,
            });
        } finally {
            setBusy(false);
        }
    }, [prefix, setlistId, router]);

    // Finalize a draft: lock it as the settled program. revertToDraft flips it back.
    const finalize = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch(`/api${prefix}/setlist/${setlistId}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: "final" }),
            });
            if (res.ok) router.refresh();
            else
                setStatus({
                    text: `Could not finalize (${res.status}).`,
                    ok: false,
                });
        } catch {
            setStatus({
                text: "Could not finalize. The server was unreachable.",
                ok: false,
            });
        } finally {
            setBusy(false);
        }
    }, [prefix, setlistId, router]);

    // Publish freezes the current order as the member-visible set; unpublish withdraws it.
    const setPublished = useCallback(
        async (on: boolean) => {
            setBusy(true);
            try {
                const res = await fetch(
                    `/api${prefix}/setlist/${setlistId}/publish`,
                    { method: on ? "POST" : "DELETE" },
                );
                if (res.ok) router.refresh();
                else
                    setStatus({
                        text: `Could not ${on ? "publish" : "unpublish"} (${res.status}).`,
                        ok: false,
                    });
            } catch {
                setStatus({ text: "Could not reach the server.", ok: false });
            } finally {
                setBusy(false);
            }
        },
        [prefix, setlistId, router],
    );

    // Share the LIVE draft with members, or stop. Distinct from publish: not frozen — the members'
    // copy keeps updating as the director edits (the order-changing routes resync it). router.refresh
    // so the toggle reflects the new state.
    const setShared = useCallback(
        async (on: boolean) => {
            setBusy(true);
            try {
                const res = await fetch(
                    `/api${prefix}/setlist/${setlistId}/share`,
                    { method: on ? "POST" : "DELETE" },
                );
                if (res.ok) router.refresh();
                else
                    setStatus({
                        text: `Could not ${on ? "share" : "stop sharing"} the draft (${res.status}).`,
                        ok: false,
                    });
            } catch {
                setStatus({ text: "Could not reach the server.", ok: false });
            } finally {
                setBusy(false);
            }
        },
        [prefix, setlistId, router],
    );

    // Pin actions. Setting an end clears the opposite end if it held the same song
    // and lifts any exclude; exclude lifts the song from every other pin.
    const setOpen = (id: string) =>
        applyPins({
            ...pins,
            open: pins.open === id ? null : id,
            close: pins.close === id ? null : pins.close,
            excluded: without(pins.excluded, id),
        });
    const setClose = (id: string) =>
        applyPins({
            ...pins,
            close: pins.close === id ? null : id,
            open: pins.open === id ? null : pins.open,
            excluded: without(pins.excluded, id),
        });
    const exclude = (id: string) =>
        applyPins({
            open: pins.open === id ? null : pins.open,
            close: pins.close === id ? null : pins.close,
            keep: without(pins.keep, id),
            excluded: withId(pins.excluded, id),
        });
    const restore = (id: string) =>
        applyPins({ ...pins, excluded: without(pins.excluded, id) });
    const keep = (id: string) =>
        applyPins({
            ...pins,
            keep: withId(pins.keep, id),
            excluded: without(pins.excluded, id),
        });
    const unkeep = (id: string) =>
        applyPins({ ...pins, keep: without(pins.keep, id) });

    const entries = order
        .map((id) => bySong.get(id))
        .filter((e): e is SetEntry => e !== undefined);

    // Show seams only when they belong to the order on screen.
    const liveSeams = seamsKey === keyOf(order) ? seams : [];

    // A finalized set is locked: disable every editing affordance (drag, pins, notes,
    // segues, breaks, bench/restore/keep), the same way an in-flight write does.
    const lockedBusy = busy || locked;

    return (
        <main className="page setlist-page">
            <Link href={`${prefix}/events`} className="back-link">
                &larr; All events
            </Link>
            <div className="page-head">
                <div>
                    <h1>{locked ? "Finalized set" : "Draft set"}</h1>
                    <div className="sub">
                        {entries.length} song{entries.length === 1 ? "" : "s"}
                        {busy ? " · working…" : ""}
                    </div>
                </div>
                <div className="head-actions">
                    <Link
                        href={`${prefix}/setlist/${setlistPublicId}/sheet?order=${encodeURIComponent(
                            order
                                .map((id) => tokenById.get(id) ?? id)
                                .join(","),
                        )}`}
                        className="ctl regen"
                    >
                        Print running order
                    </Link>
                    <button
                        type="button"
                        className="ctl regen"
                        disabled={busy}
                        onClick={() => setPublished(!publishedAt)}
                        title={
                            publishedAt
                                ? "Members can see this set; it updates as you edit, until you mark it performed. Click to withdraw it."
                                : "Show this set to members. It stays current as you edit, until you mark it performed."
                        }
                    >
                        {publishedAt ? "Unpublish" : "Publish to members"}
                    </button>
                    {!locked && !publishedAt && (
                        <button
                            type="button"
                            className={`ctl regen${shareDraft ? " on" : ""}`}
                            disabled={busy || entries.length === 0}
                            onClick={() => setShared(!shareDraft)}
                            title={
                                shareDraft
                                    ? "Members can see this live draft; it updates as you edit. Click to stop."
                                    : "Let members see this draft live, before you publish. It stays current as you edit."
                            }
                        >
                            {shareDraft ? "Sharing draft" : "Share draft"}
                        </button>
                    )}
                    {locked ? (
                        <button
                            type="button"
                            className="ctl regen"
                            disabled={busy}
                            onClick={revertToDraft}
                        >
                            Revert to draft
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="ctl regen"
                            disabled={busy}
                            onClick={finalize}
                        >
                            Finalize
                        </button>
                    )}
                    <button
                        type="button"
                        className="perform"
                        disabled={busy || entries.length === 0}
                        onClick={markPerformed}
                    >
                        Mark performed
                    </button>
                </div>
            </div>

            {locked && (
                <p className="locked-banner">
                    <span className="epill">Final</span> This set is finalized.
                    Revert it to draft to make changes, or mark it performed.
                </p>
            )}

            {!locked ? (
                <div className="setup-row">
                    <div className="panel setup-box variety-box">
                        <div className="setup-head">
                            <span className="setup-title">Variety</span>
                            <span className="variety-val">
                                {varietyLabel(amount)}
                            </span>
                        </div>
                        <input
                            id="variety"
                            type="range"
                            min={0}
                            max={5}
                            step={0.5}
                            value={amount}
                            disabled={busy}
                            aria-label="Variety"
                            onChange={(e) =>
                                setAmount(parseFloat(e.target.value))
                            }
                        />
                        <div className="setup-foot">
                            <span className="setup-note">
                                Applies on Re-generate.
                            </span>
                            <button
                                type="button"
                                className="ctl regen"
                                disabled={busy}
                                onClick={regenerate}
                            >
                                Re-generate
                            </button>
                        </div>
                    </div>

                    <div className="panel setup-box arrange-box">
                        <div className="setup-head">
                            <span className="setup-title">Auto-arrange</span>
                        </div>
                        <p className="setup-desc">
                            Re-orders the current songs for a smoother flow,
                            keeping your opener and closer. It swaps nothing in
                            or out. That is Re-generate.
                        </p>
                        <div className="setup-foot">
                            <button
                                type="button"
                                className="ctl regen"
                                disabled={busy || entries.length < 2}
                                onClick={autoArrange}
                            >
                                Auto-arrange
                            </button>
                        </div>
                    </div>

                    <div className="panel setup-box timing-box">
                        <div className="setup-head">
                            <span className="setup-title">Running time</span>
                        </div>
                        <TimingBar
                            totalSeconds={total}
                            targetSeconds={draft.targetSeconds}
                            unknownDurations={songsOf(draft.set).some(
                                (e) => e.song.durationSeconds == null,
                            )}
                        />
                    </div>
                </div>
            ) : (
                <TimingBar
                    totalSeconds={total}
                    targetSeconds={draft.targetSeconds}
                    unknownDurations={songsOf(draft.set).some(
                        (e) => e.song.durationSeconds == null,
                    )}
                />
            )}

            {status && (
                <p className={`status${status.ok ? "" : " error"}`}>
                    {status.text}
                </p>
            )}

            <BalanceArc entries={entries} seams={liveSeams} breaks={breaks} />

            <div className="setlist-workspace">
                <div className="set-main">
                    <div className="module-head set-head">
                        <h2 className="module-title">The set</h2>
                        {manual && (
                            <span className="manual-flag">
                                Custom order · a pin change re-drafts
                            </span>
                        )}
                    </div>

                    <UnplacedPrepNotice items={payload.unplacedPrep} />

                    <EditableSetList
                        entries={entries}
                        castShort={payload.castShort}
                        eventId={payload.eventId}
                        prepIds={payload.prepIds}
                        seams={liveSeams}
                        pins={pins}
                        notes={notes}
                        transitions={transitions}
                        breaks={breaks}
                        busy={lockedBusy}
                        onReorder={reorder}
                        onSetOpen={setOpen}
                        onSetClose={setClose}
                        onExclude={exclude}
                        onUnkeep={unkeep}
                        onSetNote={onSetNote}
                        onSetTransition={onSetTransition}
                        onAddBreak={addBreak}
                        onRemoveBreak={removeBreak}
                        onEditBreakDuration={editBreakDuration}
                    />

                    {/* Reserves sit in the primary column, under the set, so a short set does not leave the
              lower-left empty beside the taller rail. */}
                    <NotInSet
                        bench={draft.bench}
                        excluded={pins.excluded}
                        drops={draft.drops}
                        titleOf={titleOf}
                        metaOf={metaOf}
                        songToken={tokenById}
                        prefix={prefix}
                        busy={lockedBusy}
                        onKeep={keep}
                        onRestore={restore}
                    />
                </div>

                <SetRail shortfall={draft.shortfall} chase={draft.chase} />
            </div>
        </main>
    );
}
