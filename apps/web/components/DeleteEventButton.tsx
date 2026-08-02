"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Delete an event and its setlist, then return to the events list.
export function DeleteEventButton({ id }: { id: string }) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const onClick = async () => {
        if (
            !window.confirm(
                "Delete this event and its setlist? This cannot be undone.",
            )
        )
            return;
        setBusy(true);
        setErr(null);
        try {
            const res = await fetch(`/api${prefix}/events/${id}`, {
                method: "DELETE",
            });
            if (res.ok) {
                router.push(`${prefix}/events`);
                router.refresh();
                return;
            }
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
            };
            setErr(body.error ?? `Could not delete (${res.status}).`);
        } catch {
            setErr("Could not reach the server.");
        }
        setBusy(false);
    };

    return (
        <span className="archive-action">
            <button
                type="button"
                className="ctl regen danger"
                disabled={busy}
                onClick={onClick}
            >
                Delete event
            </button>
            {err && <span className="archive-err">{err}</span>}
        </span>
    );
}
