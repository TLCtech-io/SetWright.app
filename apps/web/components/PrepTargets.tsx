"use client";

import { useMemo, useRef, useState } from "react";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { SongPicker, type PickerSong } from "@/components/SongPicker";
import type { PrepView, PrepSong } from "@/lib/prep";

// The gig's prep targets: songs the director has committed to have ready by the gig date.
// Each shows its ready status (performance-ready and fully cast), so the director sees at a
// glance what still needs work. The whole book sits in one filterable picker below to add
// from; the "behind schedule" insight rolls these up across gigs.

function Status({ song }: { song: PrepSong | undefined }) {
    if (!song) return null;
    if (!song.notReady && !song.undercast)
        return <span className="prep-status ready">Ready</span>;
    return (
        <span className="prep-tags">
            {song.notReady && (
                <span className="prep-status not-ready">Not ready</span>
            )}
            {song.undercast && (
                <span className="prep-status undercast">Undercast</span>
            )}
        </span>
    );
}

export function PrepTargets({
    eventId,
    view,
}: {
    eventId: string;
    view: PrepView;
}) {
    const prefix = useEnsemblePrefix();

    const songById = useMemo(
        () => new Map(view.songs.map((s) => [s.id, s])),
        [view.songs],
    );
    const [ids, setIds] = useState<string[]>(() =>
        view.targetIds.filter((id) => songById.has(id)),
    );
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
    // Bumped on every edit. A save snapshots it and only clears dirty if it is unchanged when
    // the write returns, so an edit made while the save was in flight is not silently dropped.
    const editGen = useRef(0);

    const idSet = useMemo(() => new Set(ids), [ids]);
    const readyCount = ids.filter((id) => {
        const s = songById.get(id);
        return s && !s.notReady && !s.undercast;
    }).length;

    // The whole book, minus the current targets, shaped for the picker. Readiness rides the
    // built-in status dot; only the casting gap needs its own badge.
    const candidates = useMemo<PickerSong[]>(
        () =>
            view.songs
                .filter((s) => !idSet.has(s.id))
                .map((s) => ({
                    id: s.id,
                    title: s.title,
                    readiness: s.readiness,
                    lastRehearsed: s.lastRehearsed,
                    durationSeconds: s.durationSeconds,
                    tags: s.tags,
                    badges: s.undercast ? (
                        <span className="prep-status undercast">Undercast</span>
                    ) : undefined,
                })),
        [view.songs, idSet],
    );

    const mutate = (next: string[]) => {
        editGen.current += 1;
        setIds(next);
        setDirty(true);
        setMsg(null);
    };
    const remove = (id: string) => mutate(ids.filter((x) => x !== id));
    const add = (id: string) => {
        if (!id || idSet.has(id)) return;
        mutate([...ids, id]);
    };

    const save = async () => {
        setSaving(true);
        setMsg(null);
        const sent = ids; // the set the director is committing to
        const gen = editGen.current;
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/prep`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ songIds: sent }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
            };
            if (res.ok) {
                // Keep dirty if the list changed while the write was in flight, so the newer edit can
                // still be saved. No route or refresh: the list already reflects the save.
                if (editGen.current === gen) setDirty(false);
                setMsg({ text: "Prep list saved.", ok: true });
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
        <div className="prep">
            <p className="prep-intro">
                Songs to have ready for this gig.{" "}
                {ids.length > 0
                    ? `${readyCount} of ${ids.length} ready.`
                    : "None set yet."}
            </p>

            {ids.length > 0 ? (
                <ul className="prep-list">
                    {ids.map((id) => (
                        <li key={id} className="prep-row">
                            <span className="prep-title">
                                {songById.get(id)?.title ?? id}
                            </span>
                            <Status song={songById.get(id)} />
                            <button
                                type="button"
                                className="ctl prep-remove"
                                onClick={() => remove(id)}
                                aria-label="Remove"
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="prep-empty">
                    Add the songs you need ready for this gig.
                </p>
            )}

            <div className="prep-pick">
                <p className="section-label">Add from the book</p>
                <SongPicker
                    songs={candidates}
                    onAdd={add}
                    emptyLabel="Every active song is already a target."
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
                    {saving ? "Saving…" : "Save prep list"}
                </button>
            </div>
        </div>
    );
}
