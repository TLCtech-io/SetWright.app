"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Remove a saved program. A program assigned to an event cannot be deleted (the
// schema restricts it via setlist.program_id), so the control is disabled with a
// reason. Otherwise it confirms first and surfaces failure rather than faking success.
export function DeletePlaygroundButton({
    id,
    name,
    assigned,
}: {
    id: string;
    name: string;
    assigned: boolean;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (assigned) {
        return (
            <button
                type="button"
                className="ctl"
                disabled
                title="Assigned to an event, cannot delete"
            >
                Delete
            </button>
        );
    }

    const onClick = async () => {
        if (!confirm(`Delete the program "${name}"? This cannot be undone.`))
            return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api${prefix}/playground/${id}`, {
                method: "DELETE",
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setError(
                    typeof body.error === "string"
                        ? body.error
                        : `failed (${res.status})`,
                );
                return;
            }
            router.refresh();
        } catch {
            setError("Could not reach the server.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="archive-action">
            <button
                type="button"
                className="ctl danger"
                disabled={busy}
                onClick={onClick}
            >
                Delete
            </button>
            {error && (
                <span className="archive-err" title={error}>
                    failed
                </span>
            )}
        </span>
    );
}
