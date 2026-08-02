"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MyEnsemble } from "@/lib/ensemble";

export function EnsemblesManager({
    ensembles,
    active,
    canFound,
}: {
    ensembles: MyEnsemble[];
    active: string | null;
    canFound: boolean;
}) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [switchingId, setSwitchingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Synchronous re-entry guard. State updates (and so the button's `disabled`) commit a tick
    // late, so a fast double-click fires the handler twice before the button visibly disables —
    // which was minting duplicate ensembles. A ref flips immediately, so the second call bails here.
    const pending = useRef(false);
    const anyPending = creating || switchingId !== null;

    // uuid scopes the switch (the cookie is uuid-based) and keys the pending state; token is the URL.
    async function switchTo(uuid: string, token: string) {
        if (pending.current) return;
        pending.current = true;
        setSwitchingId(uuid);
        setError(null);
        try {
            const res = await fetch("/api/ensembles/switch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ensembleId: uuid }),
            });
            if (!res.ok) {
                // No longer a member (e.g. removed) — say so and refresh so the stale row drops, rather than
                // navigating into an ensemble that just bounces back to /ensembles with no explanation.
                setError("You are no longer a member of that ensemble.");
                pending.current = false;
                setSwitchingId(null);
                router.refresh();
                return;
            }
        } catch {
            setError("Could not reach the server.");
            pending.current = false;
            setSwitchingId(null);
            return;
        }
        // Land on the dashboard — the home inside an ensemble, matching login and the nav switcher.
        // Stay pending through the navigation so the row can't be re-fired mid-transit.
        router.push(`/e/${token}/dashboard`);
        router.refresh();
    }

    async function create(e: FormEvent) {
        e.preventDefault();
        if (pending.current) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        pending.current = true;
        setCreating(true);
        setError(null);
        try {
            const res = await fetch("/api/ensembles/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: trimmed }),
            });
            if (!res.ok) {
                // Surface the route's own message (e.g. the no-credit 403 or the max-ensembles 409) rather than a
                // generic string, so the director learns the actual reason.
                const body = (await res.json().catch(() => ({}))) as {
                    error?: string;
                };
                setError(body.error ?? "Could not create the ensemble.");
                pending.current = false;
                setCreating(false);
                return;
            }
            // The create endpoint returns the new ensemble's uuid + URL token; navigate by the token.
            const { publicId } = (await res.json()) as {
                id: string;
                publicId: string;
            };
            router.push(`/e/${publicId}/dashboard`);
            router.refresh();
        } catch {
            setError("Could not reach the server.");
            pending.current = false;
            setCreating(false);
        }
    }

    return (
        <>
            <ul className="ensemble-list">
                {ensembles.map((e) => (
                    <li key={e.id} className={e.id === active ? "active" : ""}>
                        <span>
                            {e.name}{" "}
                            <span
                                className={`role-tag${e.role === "member" ? " nonsinging" : ""}`}
                            >
                                {e.role.replace("_", " ")}
                            </span>
                        </span>
                        {e.id === active ? (
                            <span className="epill on">active</span>
                        ) : (
                            <button
                                type="button"
                                className="ctl"
                                onClick={() => switchTo(e.id, e.publicId)}
                                disabled={anyPending}
                            >
                                {switchingId === e.id ? "Switching…" : "Switch"}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {canFound ? (
                <form className="create-ensemble" onSubmit={create}>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="New ensemble name"
                        aria-label="New ensemble name"
                        disabled={anyPending}
                    />
                    <button
                        type="submit"
                        className="perform"
                        disabled={anyPending}
                    >
                        {creating ? "Creating…" : "Create ensemble"}
                    </button>
                </form>
            ) : (
                <p className="ensembles-note">
                    Creating a new ensemble needs an invitation. Contact us for
                    access.
                </p>
            )}
            {/* Outside the create form so a switch error still shows when the form is hidden (no credit). */}
            {error && (
                <p className="login-error" role="alert">
                    {error}
                </p>
            )}
        </>
    );
}
