"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PaddingProfileRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

type Usage = Record<string, { eventTypes: number }>;

const intOr0 = (v: string): number => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
};

// The reusable padding-profile editor. Same server-driven shape as the other
// vocabulary managers (render from props, mutate then router.refresh()); no reorder
// (the schema has no sort_order on padding_profile).
export function PaddingProfilesManager({
    initial,
    usage,
}: {
    initial: PaddingProfileRow[];
    usage: Usage;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    const [eName, setEName] = useState("");
    const [eSong, setESong] = useState("0");
    const [eSet, setESet] = useState("0");

    const [nName, setNName] = useState("");
    const [nSong, setNSong] = useState("30");
    const [nSet, setNSet] = useState("60");

    const startEdit = (p: PaddingProfileRow) => {
        setEditingId(p.id);
        setEName(p.name);
        setESong(String(p.perSongSeconds));
        setESet(String(p.perSetSeconds));
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
        if (!eName.trim()) {
            setError("A profile name is required.");
            return;
        }
        const ok = await send(`/api/padding-profiles/${id}`, "PUT", {
            name: eName.trim(),
            perSongSeconds: intOr0(eSong),
            perSetSeconds: intOr0(eSet),
        });
        if (ok) {
            setEditingId(null);
            router.refresh();
        }
    };

    const create = async () => {
        if (!nName.trim()) {
            setError("A profile name is required.");
            return;
        }
        const ok = await send("/api/padding-profiles", "POST", {
            name: nName.trim(),
            perSongSeconds: intOr0(nSong),
            perSetSeconds: intOr0(nSet),
        });
        if (ok) {
            setNName("");
            setNSong("30");
            setNSet("60");
            router.refresh();
        }
    };

    const remove = async (p: PaddingProfileRow) => {
        const u = usage[p.id] ?? { eventTypes: 0 };
        if (
            u.eventTypes > 0 &&
            !confirm(
                `Delete "${p.name}"? ${u.eventTypes} event type${u.eventTypes === 1 ? "" : "s"} will fall back to the default padding.`,
            )
        ) {
            return;
        }
        const ok = await send(
            `/api/padding-profiles/${p.id}`,
            "DELETE",
            undefined,
            true,
        );
        if (ok) router.refresh();
    };

    return (
        <div className="vp-manager">
            {error && <p className="callout shortfall">{error}</p>}

            <div className="vp-list">
                {initial.map((p) => {
                    const u = usage[p.id] ?? { eventTypes: 0 };
                    const editing = editingId === p.id;
                    return (
                        <div key={p.id} className="vp-row">
                            {editing ? (
                                <div className="vp-edit">
                                    <input
                                        className="part-label"
                                        value={eName}
                                        onChange={(e) =>
                                            setEName(e.target.value)
                                        }
                                        placeholder="Profile name"
                                        aria-label="Profile name"
                                    />
                                    <label className="part-count">
                                        per song
                                        <input
                                            type="number"
                                            min={0}
                                            value={eSong}
                                            onChange={(e) =>
                                                setESong(e.target.value)
                                            }
                                        />
                                    </label>
                                    <label className="part-count">
                                        per set
                                        <input
                                            type="number"
                                            min={0}
                                            value={eSet}
                                            onChange={(e) =>
                                                setESet(e.target.value)
                                            }
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="perform"
                                        disabled={busy}
                                        onClick={() => saveEdit(p.id)}
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
                                        <div className="vp-name">{p.name}</div>
                                        <div className="rep-meta">
                                            {p.perSongSeconds}s / song &middot;{" "}
                                            {p.perSetSeconds}s / set &middot;{" "}
                                            {u.eventTypes} type
                                            {u.eventTypes === 1 ? "" : "s"}
                                        </div>
                                    </div>
                                    <div className="vp-actions">
                                        <button
                                            type="button"
                                            className="ctl"
                                            disabled={busy}
                                            onClick={() => startEdit(p)}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            className="ctl danger"
                                            disabled={busy}
                                            onClick={() => remove(p)}
                                        >
                                            Delete
                                        </button>
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
                    value={nName}
                    onChange={(e) => setNName(e.target.value)}
                    placeholder="New profile (e.g. Competition)"
                    aria-label="New profile name"
                />
                <label className="part-count">
                    per song
                    <input
                        type="number"
                        min={0}
                        value={nSong}
                        onChange={(e) => setNSong(e.target.value)}
                    />
                </label>
                <label className="part-count">
                    per set
                    <input
                        type="number"
                        min={0}
                        value={nSet}
                        onChange={(e) => setNSet(e.target.value)}
                    />
                </label>
                <button
                    type="button"
                    className="perform"
                    disabled={busy}
                    onClick={create}
                >
                    Add profile
                </button>
            </div>
        </div>
    );
}
