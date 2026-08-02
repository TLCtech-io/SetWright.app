"use client";

import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { midi, noteName } from "@repertoire/core";
import type { MemberRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { browserClient } from "@/lib/supabase/client";

// A member editing their OWN profile: display name + vocal range. Role, sections, and
// status are the director's to set, so they aren't here. Posts to /me/profile, which calls
// the update_my_profile RPC (self-scoped). Range mirrors the director's MemberForm: entered
// and shown as scientific pitch (G3, C6), validated to the MIDI range.
const validNote = (s: string): boolean => {
    if (!s.trim()) return true;
    try {
        const n = midi(s.trim());
        return n >= 0 && n <= 127;
    } catch {
        return false;
    }
};

export function MemberProfileForm({
    initial,
    authEnabled,
}: {
    initial: MemberRow;
    authEnabled: boolean;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [name, setName] = useState(initial.displayName);
    const [low, setLow] = useState(
        initial.rangeLowMidi != null ? noteName(initial.rangeLowMidi) : "",
    );
    const [high, setHigh] = useState(
        initial.rangeHighMidi != null ? noteName(initial.rangeHighMidi) : "",
    );
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [ok, setOk] = useState(false);
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [pwBusy, setPwBusy] = useState(false);
    const [pwMsg, setPwMsg] = useState<string | null>(null);
    const [pwOk, setPwOk] = useState(false);
    const [current, setCurrent] = useState("");
    const [needsCurrent, setNeedsCurrent] = useState(false);
    const [email, setEmail] = useState<string | null>(null);
    const [newEmail, setNewEmail] = useState("");
    const [emailBusy, setEmailBusy] = useState(false);
    const [emailMsg, setEmailMsg] = useState<string | null>(null);
    const [emailOk, setEmailOk] = useState(false);

    // A session signed in with a password can prove it by re-entering that password, so we ask for
    // the current one before changing it. A session from a magic link (accepting an invite, or
    // completing a forgot-password recovery) has no password to re-enter, so requiring one would
    // dead-end that path. Read how this session authenticated from the token's amr claim, and only
    // gate the change when it was a password sign-in. If the claim can't be read, leave the gate off.
    useEffect(() => {
        if (!authEnabled) return;
        browserClient()
            .auth.getSession()
            .then(({ data }) => {
                const session = data.session;
                if (!session) return;
                setEmail(session.user.email ?? null);
                const part = session.access_token.split(".")[1];
                if (!part) return;
                try {
                    const payload = JSON.parse(
                        atob(part.replace(/-/g, "+").replace(/_/g, "/")),
                    ) as {
                        amr?: Array<{ method?: string }>;
                    };
                    setNeedsCurrent(
                        (payload.amr ?? []).some(
                            (m) => m.method === "password",
                        ),
                    );
                } catch {
                    // A malformed token leaves needsCurrent false, which matches the pre-existing behavior.
                }
            });
    }, [authEnabled]);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!name.trim()) {
            setOk(false);
            setMsg("A name is required.");
            return;
        }
        if (!validNote(low) || !validNote(high)) {
            setOk(false);
            setMsg("Range notes must be scientific pitch, like G3 or C6.");
            return;
        }
        setSaving(true);
        setMsg(null);
        try {
            const res = await fetch(`/api${prefix}/me/profile`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    displayName: name.trim(),
                    rangeLow: low.trim(),
                    rangeHigh: high.trim(),
                }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
            };
            if (res.ok) {
                setOk(true);
                setMsg("Profile saved.");
                router.refresh();
            } else {
                setOk(false);
                setMsg(body.error ?? `Could not save (${res.status}).`);
            }
        } catch {
            setOk(false);
            setMsg("Could not reach the server.");
        } finally {
            setSaving(false);
        }
    }

    // Change the account password directly against Supabase auth, like the invite welcome screen. Only
    // rendered in supabase mode. A member arriving from a forgot-password magic link has a recent
    // session, so updateUser is allowed — this is what makes the login form's "set a new password from
    // your profile" recovery path actually complete instead of dead-ending.
    async function changePassword(e: FormEvent) {
        e.preventDefault();
        if (password.length < 8) {
            setPwOk(false);
            setPwMsg("Use at least 8 characters.");
            return;
        }
        if (password !== confirm) {
            setPwOk(false);
            setPwMsg("The two passwords do not match.");
            return;
        }
        if (needsCurrent && !current) {
            setPwOk(false);
            setPwMsg("Enter your current password.");
            return;
        }
        setPwBusy(true);
        setPwMsg(null);
        // Verify the current password by re-signing-in with it before allowing the change, so an
        // unattended password session cannot be repurposed by someone who does not know it.
        if (needsCurrent && email) {
            const { error: reauthError } =
                await browserClient().auth.signInWithPassword({
                    email,
                    password: current,
                });
            if (reauthError) {
                setPwOk(false);
                setPwMsg("Your current password is not correct.");
                setPwBusy(false);
                return;
            }
        }
        const { error } = await browserClient().auth.updateUser({ password });
        if (error) {
            setPwOk(false);
            setPwMsg(error.message);
        } else {
            setPwOk(true);
            setPwMsg("Password updated. Use it next time you sign in.");
            setPassword("");
            setConfirm("");
            setCurrent("");
        }
        setPwBusy(false);
    }

    // Change the account email against Supabase auth. updateUser({ email }) does not apply the change
    // immediately: GoTrue sends a confirmation link (and, since double_confirm_changes is on, one to
    // the current address too) that lands on /auth/confirm?type=email_change. The email flips only
    // after confirmation, and the on_auth_user_updated trigger then re-mirrors it into app_user. Only
    // rendered in supabase mode.
    async function changeEmail(e: FormEvent) {
        e.preventDefault();
        const next = newEmail.trim();
        // A light client check so an obvious typo never spends a send. GoTrue does the real validation.
        if (!next || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
            setEmailOk(false);
            setEmailMsg("Enter a valid email address.");
            return;
        }
        if (email && next.toLowerCase() === email.toLowerCase()) {
            setEmailOk(false);
            setEmailMsg("That is already your email address.");
            return;
        }
        setEmailBusy(true);
        setEmailMsg(null);
        const { error } = await browserClient().auth.updateUser({
            email: next,
        });
        if (error) {
            setEmailOk(false);
            // Non-enumerating: never confirm whether an address is already registered. An in-use address
            // fails here, and the generic wording could equally be any validation issue. Rate limiting is
            // the one actionable case worth naming.
            setEmailMsg(
                error.status === 429
                    ? "Too many requests. Wait a minute, then try again."
                    : "We couldn't start that email change. Check the address and try again.",
            );
        } else {
            setEmailOk(true);
            setEmailMsg(
                `Check your inbox. We sent a confirmation link to ${next}. Your email changes once you confirm it (you may also need to confirm from your current address).`,
            );
            setNewEmail("");
        }
        setEmailBusy(false);
    }

    return (
        <>
            <form className="song-form" onSubmit={submit}>
                <section className="form-card">
                    <p className="section-label">Profile</p>
                    <label className="field">
                        <span>Name</span>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Your name"
                            autoFocus
                        />
                    </label>
                    <div className="field-row">
                        <label className="field">
                            <span>Range low</span>
                            <input
                                value={low}
                                onChange={(e) => setLow(e.target.value)}
                                placeholder="e.g. G3"
                            />
                        </label>
                        <label className="field">
                            <span>Range high</span>
                            <input
                                value={high}
                                onChange={(e) => setHigh(e.target.value)}
                                placeholder="e.g. C6"
                            />
                        </label>
                    </div>
                </section>
                {msg && (
                    <p className={`status${ok ? "" : " error"}`} role="status">
                        {msg}
                    </p>
                )}
                <div className="form-actions">
                    <button type="submit" className="perform" disabled={saving}>
                        {saving ? "Saving…" : "Save profile"}
                    </button>
                    <Link href={`${prefix}/me`} className="ctl">
                        Back
                    </Link>
                </div>
            </form>

            {authEnabled && (
                <form
                    className="song-form"
                    onSubmit={changePassword}
                    style={{ marginTop: 24 }}
                >
                    <section className="form-card">
                        <p className="section-label">Password</p>
                        {needsCurrent && (
                            <label className="field">
                                <span>Current password</span>
                                <input
                                    type="password"
                                    value={current}
                                    onChange={(e) => setCurrent(e.target.value)}
                                    autoComplete="current-password"
                                    placeholder="Your current password"
                                />
                            </label>
                        )}
                        <label className="field">
                            <span>New password</span>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                minLength={8}
                                autoComplete="new-password"
                                placeholder="At least 8 characters"
                            />
                        </label>
                        <label className="field">
                            <span>Confirm new password</span>
                            <input
                                type="password"
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                minLength={8}
                                autoComplete="new-password"
                                placeholder="Re-enter to confirm"
                            />
                        </label>
                    </section>
                    {pwMsg && (
                        <p
                            className={`status${pwOk ? "" : " error"}`}
                            role="status"
                        >
                            {pwMsg}
                        </p>
                    )}
                    <div className="form-actions">
                        <button
                            type="submit"
                            className="perform"
                            disabled={pwBusy}
                        >
                            {pwBusy ? "Saving…" : "Update password"}
                        </button>
                    </div>
                </form>
            )}

            {authEnabled && (
                <form
                    className="song-form"
                    onSubmit={changeEmail}
                    style={{ marginTop: 24 }}
                >
                    <section className="form-card">
                        <p className="section-label">Email</p>
                        {email && (
                            <label className="field">
                                <span>Current email</span>
                                <input value={email} disabled readOnly />
                            </label>
                        )}
                        <label className="field">
                            <span>New email</span>
                            <input
                                type="email"
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                                autoComplete="email"
                                placeholder="you@example.com"
                            />
                        </label>
                    </section>
                    {emailMsg && (
                        <p
                            className={`status${emailOk ? "" : " error"}`}
                            role="status"
                        >
                            {emailMsg}
                        </p>
                    )}
                    <div className="form-actions">
                        <button
                            type="submit"
                            className="perform"
                            disabled={emailBusy}
                        >
                            {emailBusy ? "Sending…" : "Change email"}
                        </button>
                    </div>
                </form>
            )}
        </>
    );
}
