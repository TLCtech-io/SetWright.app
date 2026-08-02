"use client";

import { useState } from "react";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Per-song promote-to-prep toggle on a set row. Adds or removes this one song from the gig's
// prep targets (the committed core the draft force-keeps). Surgical by design: the director
// commits only the songs they choose, so pulling set fill into prep never snowballs the set shut.
export function PrepToggle({
    eventId,
    songId,
    initial,
}: {
    eventId: string;
    songId: string;
    initial: boolean;
}) {
    const prefix = useEnsemblePrefix();
    const [on, setOn] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(false);

    const toggle = async () => {
        setBusy(true);
        setErr(false);
        const next = !on;
        try {
            const res = await fetch(`/api${prefix}/events/${eventId}/prep`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ songId, on: next }),
            });
            // Leave the toggle as-is on a failed write; the next load reconciles from the server. But
            // SURFACE the failure — a silent no-op reads as success, so the director thinks the song is
            // committed to prep when it is not.
            if (res.ok) setOn(next);
            else setErr(true);
        } catch {
            setErr(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button
                type="button"
                className={`ctl prep-toggle${on ? " on" : ""}${err ? " error" : ""}`}
                disabled={busy}
                aria-pressed={on}
                onClick={toggle}
                title={
                    err
                        ? "Couldn't save — click to try again."
                        : on
                          ? "Committed to prep. Click to drop it."
                          : "Add to the gig prep list"
                }
            >
                {on ? "✓ prep" : "+ prep"}
            </button>
            {err && (
                <span role="status" className="sr-only">
                    Could not update prep for this song. Try again.
                </span>
            )}
        </>
    );
}
