"use client";

import { type FormEvent, useRef, useState } from "react";

// Platform-admin form: invite a new director and authorize their first ensemble. POSTs the three fields
// to /api/admin/directors/invite (which re-checks admin, rate-limits, sends the invite, and grants the
// founding credit). Shows the route's result; on success the fields clear so the next invite is quick.
export function AdminDirectorInviteForm() {
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [ensembleName, setEnsembleName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Synchronous re-entry guard: `disabled` commits a tick late, so a fast double-submit could fire two
    // invites (two emails, two granted credits). A ref flips immediately, so the second call bails.
    const pending = useRef(false);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch("/api/admin/directors/invite", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, displayName, ensembleName }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                message?: string;
                error?: string;
            };
            if (!res.ok || !body.ok) {
                setError(body.error ?? "The invitation could not be sent.");
                return;
            }
            setNotice(body.message ?? "Invitation sent.");
            setEmail("");
            setDisplayName("");
            setEnsembleName("");
        } catch {
            setError(
                "The invitation could not be sent. Check your connection and try again.",
            );
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    return (
        <form className="auth-form" onSubmit={onSubmit}>
            <label className="field">
                <span>Director email</span>
                <input
                    type="email"
                    autoComplete="off"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
            </label>
            <label className="field">
                <span>Director name</span>
                <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                />
            </label>
            <label className="field">
                <span>Ensemble name</span>
                <input
                    value={ensembleName}
                    onChange={(e) => setEnsembleName(e.target.value)}
                    required
                />
            </label>
            {error && (
                <p className="login-error" role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <p className="status" role="status">
                    {notice}
                </p>
            )}
            <button type="submit" className="perform" disabled={busy}>
                {busy ? "Sending…" : "Send invite"}
            </button>
        </form>
    );
}
