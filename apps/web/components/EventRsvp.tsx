"use client";

import { useState } from "react";
import type { AvailabilityStatus } from "@repertoire/core";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

const OPTIONS: { value: AvailabilityStatus; label: string }[] = [
    { value: "in", label: "In" },
    { value: "tentative", label: "Maybe" },
    { value: "out", label: "Out" },
];

// The member's own RSVP for one event: three buttons, the current one highlighted. Each click
// writes the single row (PUT .../rsvp -> set_my_availability) optimistically, rolling back on
// failure. No version token — a self-write replaces nothing but the member's own row. This is the
// single-event twin of MySchedule's per-row control, for the gig call sheet. Re-entrancy is blocked
// with an early return rather than by disabling the just-clicked button (disabling the focused
// control would yank keyboard/AT focus to <body>).
export function EventRsvp({
    eventId,
    initial,
    eventName,
}: {
    eventId: string;
    initial: AvailabilityStatus | null;
    eventName: string;
}) {
    const prefix = useEnsemblePrefix();
    const [status, setStatus] = useState<AvailabilityStatus | null>(initial);
    const [inflight, setInflight] = useState(false);
    const [failed, setFailed] = useState(false);

    async function choose(next: AvailabilityStatus) {
        if (inflight) return;
        const prev = status;
        setInflight(true);
        setFailed(false);
        setStatus(next);
        let ok = false;
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/rsvp`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: next }),
            });
            ok = res.ok;
        } catch {
            ok = false;
        }
        setInflight(false);
        if (!ok) {
            setStatus(prev);
            setFailed(true);
        }
    }

    return (
        <div className="callsheet-rsvp" aria-busy={inflight}>
            <span className="callsheet-rsvp-label">Can you make it?</span>
            <div
                className="rsvp-controls"
                role="group"
                aria-label={`Your RSVP for ${eventName}`}
            >
                {OPTIONS.map((o) => (
                    <button
                        key={o.value}
                        type="button"
                        className={`rsvp-btn rsvp-${o.value}${status === o.value ? " on" : ""}`}
                        aria-pressed={status === o.value}
                        onClick={() => choose(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
            {failed && (
                <span className="row-error" role="alert">
                    couldn&rsquo;t save, try again
                </span>
            )}
        </div>
    );
}
