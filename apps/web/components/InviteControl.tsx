"use client";

import { type FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Director-facing control on a member's record: invite the person to claim a login, or
// resend if a pending invite hasn't been accepted. A claimed seat (the member already has
// an account) shows a read-only confirmation instead. The POST records the invite email
// (RLS-gated to the director) and sends the Supabase auth email; the response message
// reports what was delivered (or, in mock mode, that nothing was sent).
export function InviteControl({
    ensembleId,
    memberId,
    claimed,
    inviteEmail,
}: {
    ensembleId: string;
    memberId: string;
    claimed: boolean;
    inviteEmail: string | null;
}) {
    const router = useRouter();
    const [email, setEmail] = useState(inviteEmail ?? "");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [ok, setOk] = useState(false);
    // Set when the invite was blocked because the email already holds a removed seat: show a link to
    // the roster, where the director reactivates that seat instead of inviting a new one.
    const [reactivate, setReactivate] = useState(false);
    // Synchronous re-entry guard: `disabled` commits a tick late, so a fast double-submit fires the
    // handler twice and sends two invite emails. A ref flips immediately, so the second call bails.
    const pending = useRef(false);

    if (claimed) {
        return (
            <section className="invite-box">
                <p className="section-label">Account</p>
                <p className="status status-static" role="status">
                    ✓ This member has claimed an active login.
                </p>
            </section>
        );
    }

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setMsg(null);
        setReactivate(false);
        try {
            const res = await fetch(
                `/api/e/${ensembleId}/members/${memberId}/invite`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ email: email.trim() }),
                },
            );
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
                message?: string;
                reactivate?: boolean;
            };
            if (res.ok) {
                setOk(true);
                setMsg(body.message ?? "Invitation sent.");
                router.refresh();
            } else {
                setOk(false);
                setMsg(body.error ?? `Could not invite (${res.status}).`);
                setReactivate(body.reactivate === true);
            }
        } catch {
            setOk(false);
            setMsg("Could not reach the server.");
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    return (
        <section className="invite-box">
            <p className="section-label">Invite to claim a login</p>
            <p className="muted">
                {inviteEmail
                    ? `Invited as ${inviteEmail}, not accepted yet. Resend if it didn't arrive.`
                    : "Email this member a link to set up an account and self-manage their availability."}
            </p>
            <form className="invite-form" onSubmit={onSubmit}>
                <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    aria-label="Invite email"
                    required
                />
                <button type="submit" className="perform" disabled={busy}>
                    {busy
                        ? "Sending…"
                        : inviteEmail
                          ? "Resend invite"
                          : "Send invite"}
                </button>
            </form>
            {msg && (
                <p className={`status${ok ? "" : " error"}`} role="status">
                    {msg}
                    {reactivate && (
                        <>
                            {" "}
                            <Link href={`/e/${ensembleId}/roster`}>
                                Go to the roster.
                            </Link>
                        </>
                    )}
                </p>
            )}
        </section>
    );
}
