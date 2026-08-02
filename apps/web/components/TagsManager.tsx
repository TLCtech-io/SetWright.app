"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Tag } from "@repertoire/core";
import type { TagRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { RowMenu } from "./RowMenu";

type Usage = Record<
    string,
    { songs: number; events: number; eventTypes: number }
>;

// The fixed schema enum for tag categories. Mood/groove/genre are the "feel"
// categories that drive the variety arc; occasion/content carry no adjacency
// signal. null = no category.
const CATEGORIES: NonNullable<Tag["category"]>[] = [
    "mood",
    "groove",
    "genre",
    "occasion",
    "content",
];
const asCategory = (v: string): Tag["category"] =>
    v ? (v as NonNullable<Tag["category"]>) : null;

// The tag (style) vocabulary editor. Same shape as SectionsManager: the list
// comes from server props; each mutation posts then router.refresh()es. Reorder
// is optimistic so rapid clicks compose.
export function TagsManager({
    initial,
    usage,
}: {
    initial: TagRow[];
    usage: Usage;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    const [eName, setEName] = useState("");
    const [eCat, setECat] = useState<Tag["category"]>(null);

    const [nName, setNName] = useState("");
    const [nCat, setNCat] = useState<Tag["category"]>(null);

    const [pendingIds, setPendingIds] = useState<string[] | null>(null);
    const serverKey = initial.map((t) => t.id).join("|");
    useEffect(() => {
        if (!pendingIds) return;
        const ids = serverKey ? serverKey.split("|") : [];
        const sameOrder = pendingIds.join("|") === serverKey;
        const sameSet =
            pendingIds.length === ids.length &&
            pendingIds.every((id) => ids.includes(id));
        if (sameOrder || !sameSet) setPendingIds(null);
    }, [pendingIds, serverKey]);

    const byId = new Map(initial.map((t) => [t.id, t]));
    const rows = (pendingIds ?? initial.map((t) => t.id))
        .map((id) => byId.get(id))
        .filter((t): t is TagRow => t !== undefined);

    const startEdit = (t: TagRow) => {
        setEditingId(t.id);
        setEName(t.name);
        setECat(t.category);
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
        if (!eName.trim()) {
            setError("A tag name is required.");
            return;
        }
        const ok = await send(`/api/tags/${id}`, "PUT", {
            name: eName.trim(),
            category: eCat,
        });
        if (ok) {
            setEditingId(null);
            router.refresh();
        }
    };

    const create = async () => {
        if (!nName.trim()) {
            setError("A tag name is required.");
            return;
        }
        const ok = await send("/api/tags", "POST", {
            name: nName.trim(),
            category: nCat,
        });
        if (ok) {
            setNName("");
            setNCat(null);
            router.refresh();
        }
    };

    const remove = async (t: TagRow) => {
        const u = usage[t.id] ?? { songs: 0, events: 0, eventTypes: 0 };
        if (
            (u.songs > 0 || u.events > 0 || u.eventTypes > 0) &&
            !confirm(
                `Delete "${t.name}"? It will be removed from ${u.songs} song${u.songs === 1 ? "" : "s"}, ${u.events} event${u.events === 1 ? "" : "s"}, and ${u.eventTypes} event type${u.eventTypes === 1 ? "" : "s"}.`,
            )
        ) {
            return;
        }
        const ok = await send(`/api/tags/${t.id}`, "DELETE", undefined, true);
        if (ok) router.refresh();
    };

    const move = async (index: number, dir: -1 | 1) => {
        const base = pendingIds ?? initial.map((t) => t.id);
        const j = index + dir;
        if (j < 0 || j >= base.length) return;
        const order = [...base];
        [order[index], order[j]] = [order[j]!, order[index]!];
        setPendingIds(order);
        const ok = await send("/api/tags", "PATCH", { order });
        if (ok) router.refresh();
        else setPendingIds(null);
    };

    return (
        <div className="vp-manager">
            {error && <p className="callout shortfall">{error}</p>}

            <div className="vp-list">
                {rows.map((t, i) => {
                    const u = usage[t.id] ?? {
                        songs: 0,
                        events: 0,
                        eventTypes: 0,
                    };
                    const editing = editingId === t.id;
                    return (
                        <div key={t.id} className="vp-row">
                            {editing ? (
                                <div className="vp-edit">
                                    <input
                                        className="part-label"
                                        value={eName}
                                        onChange={(e) =>
                                            setEName(e.target.value)
                                        }
                                        placeholder="Tag name"
                                        aria-label="Tag name"
                                    />
                                    <select
                                        className="part-section"
                                        value={eCat ?? ""}
                                        onChange={(e) =>
                                            setECat(asCategory(e.target.value))
                                        }
                                        aria-label="Category"
                                    >
                                        <option value="">no category</option>
                                        {CATEGORIES.map((c) => (
                                            <option key={c} value={c}>
                                                {c}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        className="perform"
                                        disabled={busy}
                                        onClick={() => saveEdit(t.id)}
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
                                            {t.name}
                                            {t.category && (
                                                <span className="role-tag">
                                                    {t.category}
                                                </span>
                                            )}
                                        </div>
                                        <div className="rep-meta">
                                            {u.songs} song
                                            {u.songs === 1 ? "" : "s"} &middot;{" "}
                                            {u.events} event
                                            {u.events === 1 ? "" : "s"} &middot;{" "}
                                            {u.eventTypes} type
                                            {u.eventTypes === 1 ? "" : "s"}
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
                                            label={`Actions for ${t.name}`}
                                        >
                                            {(close) => (
                                                <>
                                                    <button
                                                        type="button"
                                                        className="row-menu-item"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            startEdit(t);
                                                            close();
                                                        }}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="row-menu-item danger"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            remove(t);
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
                    value={nName}
                    onChange={(e) => setNName(e.target.value)}
                    placeholder="New tag (e.g. swing)"
                    aria-label="New tag name"
                />
                <select
                    className="part-section"
                    value={nCat ?? ""}
                    onChange={(e) => setNCat(asCategory(e.target.value))}
                    aria-label="New tag category"
                >
                    <option value="">no category</option>
                    {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="perform"
                    disabled={busy}
                    onClick={create}
                >
                    Add tag
                </button>
            </div>
        </div>
    );
}
