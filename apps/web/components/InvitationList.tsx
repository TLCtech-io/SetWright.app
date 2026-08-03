"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export type PendingInvitation = {
    ensembleId: string;
    ensembleName: string;
    seatName: string;
};

// The consent step. Each invitation is accepted or declined on its own: a director who invited an
// address gets nothing until the person named on the seat says yes here.
//
// Accepting lands the user in that ensemble. Declining stamps the invitation so the roster shows the
// director it was refused, and removes it from this list. Either way the page is refreshed from the
// server rather than trusting local state, so a second tab that already acted cannot leave a stale row
// on screen offering an action the database will now refuse.
export function InvitationList({
    invitations,
}: {
    invitations: PendingInvitation[];
}) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const pending = useRef(false);

    async function act(
        ensembleId: string,
        action: "accept" | "decline",
    ): Promise<void> {
        if (pending.current) return;
        pending.current = true;
        setBusyId(ensembleId);
        setError(null);
        try {
            const res = await fetch(`/api/auth/invitations/${action}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ensembleId }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
                ensembleToken?: string | null;
            };
            if (!res.ok) {
                setError(body.error ?? "Something went wrong. Try again.");
                return;
            }
            if (action === "accept" && body.ensembleToken) {
                router.push(`/e/${body.ensembleToken}/dashboard`);
                router.refresh();
                return;
            }
            router.refresh();
        } catch {
            setError("Something went wrong. Try again.");
        } finally {
            pending.current = false;
            setBusyId(null);
        }
    }

    return (
        <div className="auth-form">
            {invitations.map((inv) => (
                <div key={inv.ensembleId} className="field">
                    <span>
                        {inv.ensembleName}, as {inv.seatName}
                    </span>
                    <div className="auth-actions">
                        <button
                            type="button"
                            className="perform"
                            disabled={busyId !== null}
                            onClick={() => act(inv.ensembleId, "accept")}
                        >
                            {busyId === inv.ensembleId ? "Joining…" : "Join"}
                        </button>
                        <button
                            type="button"
                            className="ctl"
                            disabled={busyId !== null}
                            onClick={() => act(inv.ensembleId, "decline")}
                        >
                            Decline
                        </button>
                    </div>
                </div>
            ))}
            {error && <p className="login-error">{error}</p>}
        </div>
    );
}
