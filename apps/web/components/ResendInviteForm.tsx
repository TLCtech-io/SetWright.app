"use client";

import { type FormEvent, useRef, useState } from "react";

// Self-serve invite resend, for a member whose invitation link expired. POSTs to /api/auth/resend, which
// re-sends only when the address has a pending seat and always answers the same way, so this form shows
// one fixed confirmation regardless of the outcome (it reveals nothing about who has an invite).
export function ResendInviteForm() {
    const [email, setEmail] = useState("");
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setNotice(null);
        try {
            const res = await fetch("/api/auth/resend", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                message?: string;
            };
            setNotice(
                body.message ??
                    "If that address has a pending invitation, we have sent it a fresh link.",
            );
        } catch {
            // The endpoint is enumeration-safe by design; on a transport error, show the same reassurance
            // rather than a distinct failure that would hint at the address's state.
            setNotice(
                "If that address has a pending invitation, we have sent it a fresh link.",
            );
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    return (
        <form className="auth-form" onSubmit={onSubmit}>
            <label className="field">
                <span>Your email</span>
                <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
            </label>
            {notice && (
                <p className="status" role="status">
                    {notice}
                </p>
            )}
            <button type="submit" className="perform" disabled={busy}>
                {busy ? "Sending…" : "Resend my invitation"}
            </button>
        </form>
    );
}
