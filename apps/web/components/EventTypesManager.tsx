"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import type { Tag } from "@repertoire/core";
import type { EventTypeRow, PaddingProfileRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { RowMenu } from "./RowMenu";
import { TagPicker } from "./TagPicker";

type Usage = Record<string, { events: number }>;
type TagSetter = Dispatch<SetStateAction<Set<string>>>;

// Toggle a tag in one set, dropping it from every other set (exclude, prefer, and
// require are mutually exclusive; the server resolves exclude over require over
// prefer, so a tag sits in at most one picker).
function toggle(name: string, setSel: TagSetter, ...setOthers: TagSetter[]) {
    setSel((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    });
    for (const setOther of setOthers) {
        setOther((prev) => {
            if (!prev.has(name)) return prev;
            const next = new Set(prev);
            next.delete(name);
            return next;
        });
    }
}

// The event-type editor: name + default padding profile + on-book/explicit defaults
// + standing prefer/exclude tag rules + reorder. Same server-driven shape as the
// other managers; optimistic reorder via pendingIds.
export function EventTypesManager({
    initial,
    usage,
    profiles,
    vocab,
}: {
    initial: EventTypeRow[];
    usage: Usage;
    profiles: PaddingProfileRow[];
    vocab: Tag[];
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    const [eName, setEName] = useState("");
    const [eProfileId, setEProfileId] = useState("");
    const [eOnBook, setEOnBook] = useState(true);
    const [eExplicit, setEExplicit] = useState(false);
    const [eAccomp, setEAccomp] = useState(true);
    const [eExclude, setEExclude] = useState<Set<string>>(new Set());
    const [ePrefer, setEPrefer] = useState<Set<string>>(new Set());
    const [eRequire, setERequire] = useState<Set<string>>(new Set());

    const [nName, setNName] = useState("");
    const [nProfileId, setNProfileId] = useState("");
    const [nOnBook, setNOnBook] = useState(true);
    const [nExplicit, setNExplicit] = useState(false);
    const [nAccomp, setNAccomp] = useState(true);
    const [nExclude, setNExclude] = useState<Set<string>>(new Set());
    const [nPrefer, setNPrefer] = useState<Set<string>>(new Set());
    const [nRequire, setNRequire] = useState<Set<string>>(new Set());

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
        .filter((t): t is EventTypeRow => t !== undefined);

    const profileName = (id: string | null): string =>
        (id && profiles.find((p) => p.id === id)?.name) || "default padding";

    const startEdit = (t: EventTypeRow) => {
        setEditingId(t.id);
        setEName(t.name);
        setEProfileId(t.paddingProfileId ?? "");
        setEOnBook(t.defaultAllowsOnBook);
        setEExplicit(t.defaultAllowsExplicit);
        setEAccomp(t.defaultAllowsAccompaniment);
        setEExclude(new Set(t.excludeTags));
        setEPrefer(new Set(t.preferTags));
        setERequire(new Set(t.requireTags));
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
            setError("An event-type name is required.");
            return;
        }
        const ok = await send(`/api/event-types/${id}`, "PUT", {
            name: eName.trim(),
            paddingProfileId: eProfileId || null,
            defaultAllowsOnBook: eOnBook,
            defaultAllowsExplicit: eExplicit,
            defaultAllowsAccompaniment: eAccomp,
            excludeTags: [...eExclude],
            preferTags: [...ePrefer],
            requireTags: [...eRequire],
        });
        if (ok) {
            setEditingId(null);
            router.refresh();
        }
    };

    const create = async () => {
        if (!nName.trim()) {
            setError("An event-type name is required.");
            return;
        }
        const ok = await send("/api/event-types", "POST", {
            name: nName.trim(),
            paddingProfileId: nProfileId || null,
            defaultAllowsOnBook: nOnBook,
            defaultAllowsExplicit: nExplicit,
            defaultAllowsAccompaniment: nAccomp,
            excludeTags: [...nExclude],
            preferTags: [...nPrefer],
            requireTags: [...nRequire],
        });
        if (ok) {
            setNName("");
            setNProfileId("");
            setNOnBook(true);
            setNExplicit(false);
            setNAccomp(true);
            setNExclude(new Set());
            setNPrefer(new Set());
            setNRequire(new Set());
            router.refresh();
        }
    };

    const remove = async (t: EventTypeRow) => {
        const u = usage[t.id] ?? { events: 0 };
        if (
            u.events > 0 &&
            !confirm(
                `Delete "${t.name}"? ${u.events} event${u.events === 1 ? "" : "s"} will become untyped but keep their settings.`,
            )
        ) {
            return;
        }
        const ok = await send(
            `/api/event-types/${t.id}`,
            "DELETE",
            undefined,
            true,
        );
        if (ok) router.refresh();
    };

    const move = async (index: number, dir: -1 | 1) => {
        const base = pendingIds ?? initial.map((t) => t.id);
        const j = index + dir;
        if (j < 0 || j >= base.length) return;
        const order = [...base];
        [order[index], order[j]] = [order[j]!, order[index]!];
        setPendingIds(order);
        const ok = await send("/api/event-types", "PATCH", { order });
        if (ok) router.refresh();
        else setPendingIds(null);
    };

    const profileSelect = (
        value: string,
        onChange: (v: string) => void,
        label: string,
    ) => (
        <select
            className="part-section"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
        >
            <option value="">Default padding</option>
            {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                    {p.name}
                </option>
            ))}
        </select>
    );

    return (
        <div className="vp-manager">
            {error && <p className="callout shortfall">{error}</p>}

            <div className="vp-list">
                {rows.map((t, i) => {
                    const u = usage[t.id] ?? { events: 0 };
                    const editing = editingId === t.id;
                    return (
                        <div key={t.id} className="vp-row et-row">
                            {editing ? (
                                <div className="et-edit">
                                    <div className="et-edit-line">
                                        <input
                                            className="part-label"
                                            value={eName}
                                            onChange={(e) =>
                                                setEName(e.target.value)
                                            }
                                            placeholder="Type name"
                                            aria-label="Type name"
                                        />
                                        {profileSelect(
                                            eProfileId,
                                            setEProfileId,
                                            "Padding profile",
                                        )}
                                        <label className="part-req">
                                            <input
                                                type="checkbox"
                                                checked={eOnBook}
                                                onChange={(e) =>
                                                    setEOnBook(e.target.checked)
                                                }
                                            />{" "}
                                            on-book
                                        </label>
                                        <label className="part-req">
                                            <input
                                                type="checkbox"
                                                checked={eExplicit}
                                                onChange={(e) =>
                                                    setEExplicit(
                                                        e.target.checked,
                                                    )
                                                }
                                            />{" "}
                                            explicit
                                        </label>
                                        <label className="part-req">
                                            <input
                                                type="checkbox"
                                                checked={eAccomp}
                                                onChange={(e) =>
                                                    setEAccomp(e.target.checked)
                                                }
                                            />{" "}
                                            accompaniment
                                        </label>
                                    </div>
                                    <div className="et-tags">
                                        <span className="et-tags-label">
                                            Prefer
                                        </span>
                                        <TagPicker
                                            vocab={vocab}
                                            selected={ePrefer}
                                            onToggle={(name) =>
                                                toggle(
                                                    name,
                                                    setEPrefer,
                                                    setEExclude,
                                                    setERequire,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="et-tags">
                                        <span className="et-tags-label">
                                            Exclude
                                        </span>
                                        <TagPicker
                                            vocab={vocab}
                                            selected={eExclude}
                                            onToggle={(name) =>
                                                toggle(
                                                    name,
                                                    setEExclude,
                                                    setEPrefer,
                                                    setERequire,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="et-tags">
                                        <span className="et-tags-label">
                                            Require
                                        </span>
                                        <TagPicker
                                            vocab={vocab}
                                            selected={eRequire}
                                            onToggle={(name) =>
                                                toggle(
                                                    name,
                                                    setERequire,
                                                    setEExclude,
                                                    setEPrefer,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="et-edit-line">
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
                                </div>
                            ) : (
                                <>
                                    <div className="vp-body">
                                        <div className="vp-name">
                                            {t.name}
                                            {!t.defaultAllowsOnBook && (
                                                <span className="role-tag nonsinging">
                                                    off-book
                                                </span>
                                            )}
                                            {t.defaultAllowsExplicit && (
                                                <span className="role-tag">
                                                    explicit ok
                                                </span>
                                            )}
                                            {!t.defaultAllowsAccompaniment && (
                                                <span className="role-tag nonsinging">
                                                    a cappella
                                                </span>
                                            )}
                                        </div>
                                        <div className="rep-meta">
                                            {profileName(t.paddingProfileId)}
                                            {t.preferTags.length > 0 && (
                                                <>
                                                    {" "}
                                                    &middot; prefer{" "}
                                                    {t.preferTags.join(", ")}
                                                </>
                                            )}
                                            {t.excludeTags.length > 0 && (
                                                <>
                                                    {" "}
                                                    &middot; exclude{" "}
                                                    {t.excludeTags.join(", ")}
                                                </>
                                            )}
                                            {t.requireTags.length > 0 && (
                                                <>
                                                    {" "}
                                                    &middot; require{" "}
                                                    {t.requireTags.join(", ")}
                                                </>
                                            )}{" "}
                                            &middot; {u.events} event
                                            {u.events === 1 ? "" : "s"}
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

            <div className="vp-row et-row vp-new">
                <div className="et-edit">
                    <div className="et-edit-line">
                        <input
                            className="part-label"
                            value={nName}
                            onChange={(e) => setNName(e.target.value)}
                            placeholder="New event type (e.g. Competition)"
                            aria-label="New event-type name"
                        />
                        {profileSelect(
                            nProfileId,
                            setNProfileId,
                            "New padding profile",
                        )}
                        <label className="part-req">
                            <input
                                type="checkbox"
                                checked={nOnBook}
                                onChange={(e) => setNOnBook(e.target.checked)}
                            />{" "}
                            on-book
                        </label>
                        <label className="part-req">
                            <input
                                type="checkbox"
                                checked={nExplicit}
                                onChange={(e) => setNExplicit(e.target.checked)}
                            />{" "}
                            explicit
                        </label>
                        <label className="part-req">
                            <input
                                type="checkbox"
                                checked={nAccomp}
                                onChange={(e) => setNAccomp(e.target.checked)}
                            />{" "}
                            accompaniment
                        </label>
                        <button
                            type="button"
                            className="perform"
                            disabled={busy}
                            onClick={create}
                        >
                            Add type
                        </button>
                    </div>
                    <div className="et-tags">
                        <span className="et-tags-label">Prefer</span>
                        <TagPicker
                            vocab={vocab}
                            selected={nPrefer}
                            onToggle={(name) =>
                                toggle(
                                    name,
                                    setNPrefer,
                                    setNExclude,
                                    setNRequire,
                                )
                            }
                        />
                    </div>
                    <div className="et-tags">
                        <span className="et-tags-label">Exclude</span>
                        <TagPicker
                            vocab={vocab}
                            selected={nExclude}
                            onToggle={(name) =>
                                toggle(
                                    name,
                                    setNExclude,
                                    setNPrefer,
                                    setNRequire,
                                )
                            }
                        />
                    </div>
                    <div className="et-tags">
                        <span className="et-tags-label">Require</span>
                        <TagPicker
                            vocab={vocab}
                            selected={nRequire}
                            onToggle={(name) =>
                                toggle(
                                    name,
                                    setNRequire,
                                    setNExclude,
                                    setNPrefer,
                                )
                            }
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
