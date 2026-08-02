"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { noteName } from "@repertoire/core";
import type { VoicePartRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { RowMenu } from "./RowMenu";

type Usage = Record<string, { parts: number; members: number }>;

// The section (voice-part) vocabulary editor. The list itself comes straight from
// the server props; each mutation posts and then router.refresh()es, so the page
// re-reads and re-renders with the updated vocabulary. Only transient edit state
// lives here.
export function SectionsManager({
    initial,
    usage,
}: {
    initial: VoicePartRow[];
    usage: Usage;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    // Edit-row fields (one row at a time).
    const [eLabel, setELabel] = useState("");
    const [ePitched, setEPitched] = useState(true);
    const [eLow, setELow] = useState("");
    const [eHigh, setEHigh] = useState("");

    // New-section fields.
    const [nLabel, setNLabel] = useState("");
    const [nPitched, setNPitched] = useState(true);
    const [nLow, setNLow] = useState("");
    const [nHigh, setNHigh] = useState("");

    // Optimistic reorder: hold the in-flight order locally so a second arrow click
    // composes on the first instead of re-reading the not-yet-refreshed server prop.
    // Cleared once the server reflects it, or once the set of sections changes under
    // it (a create/delete supersedes a pending reorder).
    const [pendingIds, setPendingIds] = useState<string[] | null>(null);
    const serverKey = initial.map((v) => v.id).join("|");
    useEffect(() => {
        if (!pendingIds) return;
        const ids = serverKey ? serverKey.split("|") : [];
        const sameOrder = pendingIds.join("|") === serverKey;
        const sameSet =
            pendingIds.length === ids.length &&
            pendingIds.every((id) => ids.includes(id));
        if (sameOrder || !sameSet) setPendingIds(null);
    }, [pendingIds, serverKey]);

    const byId = new Map(initial.map((v) => [v.id, v]));
    const rows = (pendingIds ?? initial.map((v) => v.id))
        .map((id) => byId.get(id))
        .filter((v): v is VoicePartRow => v !== undefined);

    const startEdit = (vp: VoicePartRow) => {
        setEditingId(vp.id);
        setELabel(vp.label);
        setEPitched(vp.isPitched);
        setELow(vp.nominalLowMidi != null ? noteName(vp.nominalLowMidi) : "");
        setEHigh(
            vp.nominalHighMidi != null ? noteName(vp.nominalHighMidi) : "",
        );
        setError(null);
    };

    const prefix = useEnsemblePrefix();
    const send = async (
        url: string,
        method: string,
        body?: unknown,
        okIf404 = false,
    ): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api${prefix}` + url.slice(4), {
                method,
                headers: body
                    ? { "content-type": "application/json" }
                    : undefined,
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!res.ok) {
                // A 404 on delete means the row is already gone — idempotent success, not
                // an error to flash (e.g. a rapid second Delete click during the refresh).
                if (okIf404 && res.status === 404) return true;
                const b = await res.json().catch(() => ({}));
                setError(b.error ?? `failed (${res.status})`);
                return false;
            }
            return true;
        } catch {
            setError("Could not reach the server.");
            return false;
        } finally {
            setBusy(false);
        }
    };

    const saveEdit = async (id: string) => {
        if (!eLabel.trim()) {
            setError("A section name is required.");
            return;
        }
        const ok = await send(`/api/voice-parts/${id}`, "PUT", {
            label: eLabel.trim(),
            isPitched: ePitched,
            nominalLow: eLow.trim(),
            nominalHigh: eHigh.trim(),
        });
        if (ok) {
            setEditingId(null);
            router.refresh();
        }
    };

    const create = async () => {
        if (!nLabel.trim()) {
            setError("A section name is required.");
            return;
        }
        const ok = await send("/api/voice-parts", "POST", {
            label: nLabel.trim(),
            isPitched: nPitched,
            nominalLow: nLow.trim(),
            nominalHigh: nHigh.trim(),
        });
        if (ok) {
            setNLabel("");
            setNPitched(true);
            setNLow("");
            setNHigh("");
            router.refresh();
        }
    };

    const remove = async (vp: VoicePartRow) => {
        const u = usage[vp.id] ?? { parts: 0, members: 0 };
        if (u.parts > 0) {
            setError(
                `"${vp.label}" is used by ${u.parts} part${u.parts === 1 ? "" : "s"}; reassign them first.`,
            );
            return;
        }
        if (
            u.members > 0 &&
            !confirm(
                `Remove "${vp.label}"? ${u.members} member${u.members === 1 ? "" : "s"} will lose this section.`,
            )
        ) {
            return;
        }
        const ok = await send(
            `/api/voice-parts/${vp.id}`,
            "DELETE",
            undefined,
            true,
        );
        if (ok) router.refresh();
    };

    const move = async (index: number, dir: -1 | 1) => {
        const base = pendingIds ?? initial.map((v) => v.id);
        const j = index + dir;
        if (j < 0 || j >= base.length) return;
        const order = [...base];
        [order[index], order[j]] = [order[j]!, order[index]!];
        setPendingIds(order); // optimistic — a follow-up move composes on this
        const ok = await send("/api/voice-parts", "PATCH", { order });
        if (ok) router.refresh();
        else setPendingIds(null); // revert to the server order on failure
    };

    const rangeLabel = (vp: VoicePartRow): string => {
        if (!vp.isPitched) return "unpitched";
        if (vp.nominalLowMidi == null && vp.nominalHighMidi == null)
            return "no range";
        const lo =
            vp.nominalLowMidi != null ? noteName(vp.nominalLowMidi) : "?";
        const hi =
            vp.nominalHighMidi != null ? noteName(vp.nominalHighMidi) : "?";
        return `${lo}–${hi}`;
    };

    return (
        <div className="vp-manager">
            {error && <p className="callout shortfall">{error}</p>}

            <div className="vp-list">
                {rows.map((vp, i) => {
                    const u = usage[vp.id] ?? { parts: 0, members: 0 };
                    const editing = editingId === vp.id;
                    return (
                        <div key={vp.id} className="vp-row">
                            {editing ? (
                                <div className="vp-edit">
                                    <input
                                        className="part-label"
                                        value={eLabel}
                                        onChange={(e) =>
                                            setELabel(e.target.value)
                                        }
                                        placeholder="Section name"
                                        aria-label="Section name"
                                    />
                                    <label className="part-req">
                                        <input
                                            type="checkbox"
                                            checked={ePitched}
                                            onChange={(e) => {
                                                setEPitched(e.target.checked);
                                                if (!e.target.checked) {
                                                    setELow("");
                                                    setEHigh("");
                                                }
                                            }}
                                        />
                                        pitched
                                    </label>
                                    <input
                                        className="part-range"
                                        value={eLow}
                                        disabled={!ePitched}
                                        onChange={(e) =>
                                            setELow(e.target.value)
                                        }
                                        placeholder="low (C4)"
                                        aria-label="Nominal low"
                                    />
                                    <input
                                        className="part-range"
                                        value={eHigh}
                                        disabled={!ePitched}
                                        onChange={(e) =>
                                            setEHigh(e.target.value)
                                        }
                                        placeholder="high (A5)"
                                        aria-label="Nominal high"
                                    />
                                    <button
                                        type="button"
                                        className="perform"
                                        disabled={busy}
                                        onClick={() => saveEdit(vp.id)}
                                    >
                                        Save
                                    </button>
                                    <button
                                        type="button"
                                        className="ctl"
                                        disabled={busy}
                                        onClick={() => setEditingId(null)}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="vp-body">
                                        <div className="vp-name">
                                            {vp.label}
                                            {!vp.isPitched && (
                                                <span className="role-tag nonsinging">
                                                    unpitched
                                                </span>
                                            )}
                                        </div>
                                        <div className="rep-meta">
                                            {rangeLabel(vp)} &middot; {u.parts}{" "}
                                            part{u.parts === 1 ? "" : "s"}{" "}
                                            &middot; {u.members} member
                                            {u.members === 1 ? "" : "s"}
                                        </div>
                                    </div>
                                    <div className="vp-actions">
                                        <button
                                            type="button"
                                            className="ctl"
                                            disabled={busy || i === 0}
                                            onClick={() => move(i, -1)}
                                            aria-label="Move up"
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            className="ctl"
                                            disabled={
                                                busy || i === rows.length - 1
                                            }
                                            onClick={() => move(i, 1)}
                                            aria-label="Move down"
                                        >
                                            ↓
                                        </button>
                                        <RowMenu
                                            label={`Actions for ${vp.label}`}
                                        >
                                            {(close) => (
                                                <>
                                                    <button
                                                        type="button"
                                                        className="row-menu-item"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            startEdit(vp);
                                                            close();
                                                        }}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="row-menu-item danger"
                                                        disabled={
                                                            busy || u.parts > 0
                                                        }
                                                        title={
                                                            u.parts > 0
                                                                ? "Used by a chart. Reassign those parts first"
                                                                : undefined
                                                        }
                                                        onClick={() => {
                                                            remove(vp);
                                                            close();
                                                        }}
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            )}
                                        </RowMenu>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="vp-row vp-new">
                <input
                    className="part-label"
                    value={nLabel}
                    onChange={(e) => setNLabel(e.target.value)}
                    placeholder="New section (e.g. Baritone)"
                    aria-label="New section name"
                />
                <label className="part-req">
                    <input
                        type="checkbox"
                        checked={nPitched}
                        onChange={(e) => {
                            setNPitched(e.target.checked);
                            if (!e.target.checked) {
                                setNLow("");
                                setNHigh("");
                            }
                        }}
                    />
                    pitched
                </label>
                <input
                    className="part-range"
                    value={nLow}
                    disabled={!nPitched}
                    onChange={(e) => setNLow(e.target.value)}
                    placeholder="low (C4)"
                    aria-label="New nominal low"
                />
                <input
                    className="part-range"
                    value={nHigh}
                    disabled={!nPitched}
                    onChange={(e) => setNHigh(e.target.value)}
                    placeholder="high (A5)"
                    aria-label="New nominal high"
                />
                <button
                    type="button"
                    className="perform"
                    disabled={busy}
                    onClick={create}
                >
                    Add section
                </button>
            </div>
        </div>
    );
}
