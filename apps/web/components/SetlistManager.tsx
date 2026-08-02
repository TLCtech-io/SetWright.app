"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import type { SetlistMeta } from "@/lib/db";

// An event can hold several setlists. This is the list: rename, open the editor, or delete.
// Status and member-publishing are set inside the editor, so the row stays a clean list item.
// A performed set is an immutable record, shown read-only here.
export function SetlistManager({
    eventId,
    setlists,
}: {
    eventId: string;
    setlists: SetlistMeta[];
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Run a mutating request, surface failure instead of faking success, and only
    // refresh on a real success.
    const run = async (req: () => Promise<Response>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await req();
            if (!res.ok) {
                setError(`Could not save the change (${res.status}).`);
                return false;
            }
            router.refresh();
            return true;
        } catch {
            setError("Could not reach the server.");
            return false;
        } finally {
            setBusy(false);
        }
    };

    const patch = (id: string, body: Record<string, unknown>) =>
        run(() =>
            fetch(`/api${prefix}/setlist/${id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );
    const remove = (id: string) => {
        if (!window.confirm("Delete this setlist? This cannot be undone."))
            return;
        void run(() =>
            fetch(`/api${prefix}/setlist/${id}`, { method: "DELETE" }),
        );
    };
    const create = async () => {
        const ok = await run(() =>
            fetch(`/api${prefix}/events/${eventId}/setlists`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: newName.trim() || null }),
            }),
        );
        if (ok) setNewName("");
    };
    return (
        <div className="setlist-mgr">
            {setlists.length === 0 && (
                <p className="empty">
                    No setlists yet. Add one to draft this event.
                </p>
            )}

            {setlists.map((sl) => {
                const performed = sl.status === "performed";
                return (
                    <div key={sl.id} className="setlist-row">
                        <input
                            // Key on the server value so a refresh after a rename remounts the
                            // input with the fresh default, instead of the uncontrolled DOM
                            // keeping stale text that the next blur would PATCH back.
                            key={`${sl.id}:${sl.name ?? ""}`}
                            className="part-label"
                            defaultValue={sl.name ?? ""}
                            placeholder="Set name"
                            disabled={performed}
                            onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (!performed && v !== (sl.name ?? ""))
                                    patch(sl.id, { name: v });
                            }}
                        />
                        {/* Status + visibility are read-only glances here; both are set inside the editor. */}
                        <span className={`setlist-status ${sl.status}`}>
                            {sl.status}
                        </span>
                        {(performed || sl.publishedAt) && (
                            <span
                                className="setlist-published"
                                title={
                                    performed
                                        ? "A performed set is always visible to members"
                                        : "Members can currently see this set"
                                }
                            >
                                {performed ? "visible" : "published"}
                            </span>
                        )}
                        <Link
                            href={`${prefix}/setlist/${sl.publicId}`}
                            className="ctl"
                        >
                            {performed ? "View" : "Open"}
                        </Link>
                        <button
                            type="button"
                            className="ctl danger"
                            disabled={busy}
                            onClick={() => remove(sl.id)}
                        >
                            Delete
                        </button>
                    </div>
                );
            })}

            <div className="setlist-new">
                <input
                    className="part-label"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="New setlist name"
                />
                <button
                    type="button"
                    className="ctl"
                    disabled={busy}
                    onClick={create}
                >
                    Add setlist
                </button>
            </div>

            {error && <p className="status error">{error}</p>}
        </div>
    );
}
