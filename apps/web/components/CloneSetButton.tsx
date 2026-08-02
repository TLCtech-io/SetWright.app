"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Clone a performed set into a fresh draft on a chosen event, then open it.
export function CloneSetButton({
    setlistId,
    events,
}: {
    setlistId: string;
    events: { id: string; name: string }[];
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [eventId, setEventId] = useState(events[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (events.length === 0)
        return <p className="empty">No events to clone into.</p>;

    const clone = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api${prefix}/setlist/${setlistId}/clone`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ targetEventId: eventId }),
                },
            );
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(
                    typeof b.error === "string"
                        ? b.error
                        : `failed (${res.status})`,
                );
                return;
            }
            const { publicId } = await res.json();
            router.push(`${prefix}/setlist/${publicId}`);
        } catch {
            setError("Could not reach the server.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="pg-link-row">
            <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                disabled={busy}
                aria-label="Event"
            >
                {events.map((e) => (
                    <option key={e.id} value={e.id}>
                        {e.name}
                    </option>
                ))}
            </select>
            <button
                type="button"
                className="ctl"
                disabled={busy}
                onClick={clone}
            >
                Clone to event
            </button>
            {error && (
                <span className="archive-err" title={error}>
                    failed
                </span>
            )}
        </div>
    );
}
