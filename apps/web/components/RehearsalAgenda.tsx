"use client";

import { useMemo, useRef, useState } from "react";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { SongPicker, type PickerSong } from "@/components/SongPicker";
import { useListReorder } from "@/components/useListReorder";
import type { AgendaReasonKind } from "@/lib/agenda";
import type { RehearsalAgendaView, AgendaRun } from "@/lib/rehearsalView";

// The rehearsal agenda: a director-curated, ordered list of songs to run, seeded from
// ranked suggestions but never auto-filled. The saved list is on top; below it the whole
// book sits in one filterable, paginated picker with the suggestions floated to the top
// under "Most needed". Each row shows why it surfaced and, if RSVPs are in, whether it can
// be fully run tonight.

const REASON_LABEL: Record<AgendaReasonKind, string> = {
    "coverage-risk": "Coverage",
    "learning-gap": "Learning",
    stale: "Gone cold",
    "upcoming-gig": "Upcoming gig",
};

interface WorkingRow {
    songId: string;
    reason: AgendaReasonKind | null; // the top reason it was added under, or null for a director pick
    note: string;
}

function RunFlag({ run }: { run: AgendaRun | undefined }) {
    if (!run || run.run === "unknown") return null;
    if (run.run === "full")
        return <span className="agenda-run full">Can run</span>;
    const short =
        run.shortParts.length > 0
            ? `Short: ${run.shortParts.join(", ")}`
            : "Short tonight";
    return <span className="agenda-run short">{short}</span>;
}

export function RehearsalAgenda({
    eventId,
    view,
}: {
    eventId: string;
    view: RehearsalAgendaView;
}) {
    const prefix = useEnsemblePrefix();

    const songById = useMemo(
        () => new Map(view.songs.map((s) => [s.id, s])),
        [view.songs],
    );
    const [list, setList] = useState<WorkingRow[]>(() =>
        view.saved.map((i) => ({
            songId: i.songId,
            // reason is free text in the schema; only render one we have a label for. Object.hasOwn,
            // not `in`: `in` also matches inherited keys ('toString'), which would render a function.
            reason:
                i.reason && Object.hasOwn(REASON_LABEL, i.reason)
                    ? (i.reason as AgendaReasonKind)
                    : null,
            note: i.note ?? "",
        })),
    );
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
    // Bumped on every edit. A save snapshots it and only clears dirty if it is unchanged when
    // the write returns, so an edit made while the save was in flight is not silently dropped.
    const editGen = useRef(0);

    const inList = useMemo(() => new Set(list.map((r) => r.songId)), [list]);

    // The whole book, minus what is already on the agenda, shaped for the picker: ranked
    // suggestions carry their reason chips + run flag, the rest of the book is plain.
    const candidates = useMemo<PickerSong[]>(
        () =>
            view.songs
                .filter((s) => !inList.has(s.id))
                .map((s) => {
                    const hasBadges =
                        s.reasons.length > 0 || s.run.run !== "unknown";
                    return {
                        id: s.id,
                        title: s.title,
                        readiness: s.readiness,
                        lastRehearsed: s.lastRehearsed,
                        durationSeconds: s.durationSeconds,
                        tags: s.tags,
                        rank: s.rank,
                        facetValues: s.prepGigs,
                        badges: hasBadges ? (
                            <>
                                {s.reasons.map((reason) => (
                                    <span
                                        key={reason.kind}
                                        className={`agenda-reason ${reason.kind}`}
                                        title={REASON_LABEL[reason.kind]}
                                    >
                                        {reason.detail}
                                    </span>
                                ))}
                                <RunFlag run={s.run} />
                            </>
                        ) : undefined,
                    };
                }),
        [view.songs, inList],
    );

    const mutate = (next: WorkingRow[]) => {
        editGen.current += 1;
        setList(next);
        setDirty(true);
        setMsg(null);
    };
    // Reorder like the setlist: a grip to drag (mouse, touch, or pen) plus up/down buttons for the
    // accessible path. Both rewrite the working list in place and mark it dirty; the explicit Save
    // writes it. The saved order carries each row's reason and note along with it.
    const reorder = (nextIds: string[]) => {
        const byId = new Map(list.map((r) => [r.songId, r]));
        mutate(nextIds.map((id) => byId.get(id)!));
    };
    const { gripProps, wrapProps, move } = useListReorder(
        list.map((r) => r.songId),
        saving,
        reorder,
    );
    const remove = (songId: string) =>
        mutate(list.filter((r) => r.songId !== songId));
    const addSong = (songId: string) => {
        if (inList.has(songId)) return;
        mutate([
            ...list,
            {
                songId,
                reason: songById.get(songId)?.reasons[0]?.kind ?? null,
                note: "",
            },
        ]);
    };
    const setNote = (songId: string, note: string) =>
        mutate(list.map((r) => (r.songId === songId ? { ...r, note } : r)));

    const save = async () => {
        setSaving(true);
        setMsg(null);
        const items = list.map((r) => ({
            songId: r.songId,
            reason: r.reason,
            note: r.note.trim() || null,
        }));
        const gen = editGen.current;
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/agenda`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ items }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
            };
            if (res.ok) {
                // Keep dirty if the list changed while the write was in flight, so the newer edit
                // can still be saved instead of being locked out by a disabled button. No route or
                // refresh: the working list already reflects the save, an inline note is enough.
                if (editGen.current === gen) setDirty(false);
                setMsg({ text: "Agenda saved.", ok: true });
            } else {
                setMsg({
                    text: body.error ?? `Could not save (${res.status}).`,
                    ok: false,
                });
            }
        } catch {
            setMsg({ text: "Could not reach the server.", ok: false });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="agenda">
            <p className="agenda-intro">
                Ranked by what most needs the work. Add what you plan to run, in
                order. You keep the call.
                {view.inCount > 0
                    ? ` Run flags reflect the ${view.inCount} singer${view.inCount === 1 ? "" : "s"} RSVP'd in.`
                    : " Run flags appear once singers RSVP."}
            </p>

            {list.length > 0 ? (
                <ol className="agenda-list">
                    {list.map((r, i) => {
                        const wrap = wrapProps(r.songId);
                        const title = songById.get(r.songId)?.title ?? r.songId;
                        return (
                            <li
                                key={r.songId}
                                data-reorder-id={r.songId}
                                className={`agenda-row ${wrap.className}`}
                            >
                                <div className="reorder">
                                    <button
                                        type="button"
                                        className="move-btn"
                                        aria-label={`Move ${title} earlier`}
                                        disabled={saving || i === 0}
                                        onClick={() => move(r.songId, -1)}
                                    >
                                        ↑
                                    </button>
                                    <span
                                        className="grip"
                                        aria-hidden
                                        title="Drag to reorder"
                                        {...gripProps(r.songId)}
                                    >
                                        ⋮⋮
                                    </span>
                                    <button
                                        type="button"
                                        className="move-btn"
                                        aria-label={`Move ${title} later`}
                                        disabled={
                                            saving || i === list.length - 1
                                        }
                                        onClick={() => move(r.songId, 1)}
                                    >
                                        ↓
                                    </button>
                                </div>
                                <span className="agenda-pos">{i + 1}</span>
                                <div className="agenda-main">
                                    <span className="agenda-title">
                                        {title}
                                    </span>
                                    <div className="agenda-tags">
                                        {r.reason && (
                                            <span
                                                className={`agenda-reason ${r.reason}`}
                                            >
                                                {REASON_LABEL[r.reason]}
                                            </span>
                                        )}
                                        <RunFlag
                                            run={songById.get(r.songId)?.run}
                                        />
                                    </div>
                                    <input
                                        className="agenda-note"
                                        type="text"
                                        placeholder="Rehearsal note (optional)"
                                        value={r.note}
                                        onChange={(e) =>
                                            setNote(r.songId, e.target.value)
                                        }
                                    />
                                </div>
                                <button
                                    type="button"
                                    className="ctl agenda-remove"
                                    onClick={() => remove(r.songId)}
                                    aria-label={`Remove ${title}`}
                                >
                                    ×
                                </button>
                            </li>
                        );
                    })}
                </ol>
            ) : (
                <p className="agenda-empty">
                    No songs on the agenda yet. Add from the book below.
                </p>
            )}

            <div className="agenda-pick">
                <p className="section-label">Add from the book</p>
                <SongPicker
                    songs={candidates}
                    onAdd={addSong}
                    ranked
                    facet={
                        view.upcomingGigs.length > 0
                            ? {
                                  label: "upcoming gig",
                                  options: view.upcomingGigs,
                              }
                            : undefined
                    }
                    emptyLabel="Every active song is already on the agenda."
                />
            </div>

            {msg && (
                <p className={`status${msg.ok ? "" : " error"}`}>{msg.text}</p>
            )}
            <div className="form-actions">
                <button
                    type="button"
                    className="perform"
                    disabled={saving || !dirty}
                    onClick={save}
                >
                    {saving ? "Saving…" : "Save agenda"}
                </button>
            </div>
        </div>
    );
}
