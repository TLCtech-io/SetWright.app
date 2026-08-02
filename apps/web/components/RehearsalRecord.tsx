"use client";

import { useMemo, useState } from "react";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { formatEventDate } from "@/lib/format";
import type { RehearsalRecordView } from "@/lib/rehearsalView";

// Record what happened at a rehearsal: which agenda songs were run (stamps last_rehearsed,
// clearing their "gone cold" flag) and who actually came (attendance, distinct from RSVP).
// Reads the SAVED agenda, so recording never entangles with editing the plan above. Songs
// default checked, attendance defaults from each singer's RSVP; the director corrects both.

function defaultPresent(m: RehearsalRecordView["members"][number]): boolean {
    if (m.present !== null) return m.present; // already recorded
    return m.rsvp !== "out"; // lean present unless they RSVP'd out
}

export function RehearsalRecord({
    eventId,
    view,
}: {
    eventId: string;
    view: RehearsalRecordView;
}) {
    const prefix = useEnsemblePrefix();

    // Stamp last_rehearsed and attendance against the event's own date. No separate date field:
    // the event already carries the rehearsal date at the top of the page. view.date is resolved
    // server-side (the event date, else the ensemble-tz today), so recording is stamped in the
    // ensemble's day rather than the browser's UTC date.
    const date = view.date;
    const [ran, setRan] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(view.songs.map((s) => [s.songId, true])),
    );
    const [present, setPresent] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(view.members.map((m) => [m.id, defaultPresent(m)])),
    );
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

    const ranCount = useMemo(
        () => view.songs.filter((s) => ran[s.songId]).length,
        [view.songs, ran],
    );
    const presentCount = useMemo(
        () => view.members.filter((m) => present[m.id]).length,
        [view.members, present],
    );

    const toggleRan = (songId: string) => {
        setRan((p) => ({ ...p, [songId]: !p[songId] }));
        setMsg(null);
    };
    const setHere = (memberId: string, here: boolean) => {
        setPresent((p) => ({ ...p, [memberId]: here }));
        setMsg(null);
    };

    const save = async () => {
        setSaving(true);
        setMsg(null);
        const body = {
            date,
            rehearsedSongIds: view.songs
                .filter((s) => ran[s.songId])
                .map((s) => s.songId),
            attendance: view.members.map((m) => ({
                memberId: m.id,
                present: !!present[m.id],
            })),
        };
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/record`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            const resBody = (await res.json().catch(() => ({}))) as {
                error?: string;
            };
            if (res.ok) {
                setMsg({
                    text: `Recorded: ${body.rehearsedSongIds.length} rehearsed, ${presentCount} present.`,
                    ok: true,
                });
            } else {
                setMsg({
                    text: resBody.error ?? `Could not save (${res.status}).`,
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
        <div className="record">
            <p className="record-intro">
                {view.recorded
                    ? "Already recorded. Update it below."
                    : "After the rehearsal, log what you ran and who came."}
                {view.date && ` Recording for ${formatEventDate(view.date)}.`}
            </p>

            <div className="record-block">
                <p className="section-label">
                    What did you run?{" "}
                    <span className="record-count">
                        {ranCount} of {view.songs.length}
                    </span>
                </p>
                {view.songs.length > 0 ? (
                    <ul className="record-songs">
                        {view.songs.map((s) => (
                            <li key={s.songId} className="record-song">
                                <label className="record-check">
                                    <input
                                        type="checkbox"
                                        checked={!!ran[s.songId]}
                                        onChange={() => toggleRan(s.songId)}
                                    />
                                    <span className="record-song-title">
                                        {s.title}
                                    </span>
                                </label>
                                <span className="record-song-last">
                                    {s.lastRehearsed
                                        ? `last: ${formatEventDate(s.lastRehearsed)}`
                                        : "never rehearsed"}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="record-empty">
                        Add songs to the agenda above to record what you ran.
                    </p>
                )}
            </div>

            <div className="record-block">
                <p className="section-label">
                    Who came?{" "}
                    <span className="record-count">{presentCount} present</span>
                </p>
                <div className="record-members">
                    {view.members.map((m) => (
                        <div key={m.id} className="record-member">
                            <span className="record-member-name">
                                {m.displayName}
                                {m.rsvp && (
                                    <span className="record-rsvp">
                                        {" "}
                                        RSVP {m.rsvp}
                                    </span>
                                )}
                            </span>
                            <div className="record-toggle">
                                <button
                                    type="button"
                                    className={`ctl whatif-toggle in${present[m.id] ? " on" : ""}`}
                                    aria-pressed={!!present[m.id]}
                                    onClick={() => setHere(m.id, true)}
                                >
                                    present
                                </button>
                                <button
                                    type="button"
                                    className={`ctl whatif-toggle out${present[m.id] ? "" : " on"}`}
                                    aria-pressed={!present[m.id]}
                                    onClick={() => setHere(m.id, false)}
                                >
                                    absent
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {msg && (
                <p className={`status${msg.ok ? "" : " error"}`}>{msg.text}</p>
            )}
            <div className="form-actions">
                <button
                    type="button"
                    className="perform"
                    disabled={saving}
                    onClick={save}
                >
                    {saving ? "Saving…" : "Save record"}
                </button>
            </div>
        </div>
    );
}
