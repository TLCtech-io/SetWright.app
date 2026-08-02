"use client";

import { type FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { AuthShell } from "@/components/AuthShell";
import { welcomeDest } from "@/lib/welcomeDest";

// Where an invited account lands after accepting (via /auth/confirm). The seat is already
// claimed and the user is signed in; this just lets them set a password so they can sign in
// again later with the standard login form (the invite established a passwordless session).
// Setting a password is encouraged but skippable; they can always request another link.
function Welcome() {
    const router = useRouter();
    const params = useSearchParams();
    const ensembleId = params.get("e");
    const isReset = params.get("reset") === "1";
    
    // A reset (existing account) with no ensemble token goes home, not to no-access; only a stranded invite
    // goes to no-access. See lib/welcomeDest.
    const dest = welcomeDest(ensembleId, isReset);

    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    // The invite flow lands here with a live session. A stranger who revisits the URL without one
    // would otherwise fill in a password and only learn on submit that there is no session to update,
    // so check first and send a sessionless visitor to sign in.
    useEffect(() => {
        let active = true;
        browserClient()
            .auth.getUser()
            .then(({ data }) => {
                if (!active) return;
                if (data.user) setReady(true);
                else router.replace("/login");
            });
        return () => {
            active = false;
        };
    }, [router]);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (password !== confirm) {
            setError("The two passwords do not match.");
            return;
        }
        setBusy(true);
        setError(null);
        const { error } = await browserClient().auth.updateUser({ password });
        if (error) {
            setBusy(false);
            setError(error.message);
            return;
        }
        router.push(dest);
        router.refresh();
    }

    if (!ready) {
        return (
            <AuthShell>
                <div className="auth-card">
                    <p className="auth-sub">
                        {isReset
                            ? "Checking your link…"
                            : "Checking your invitation…"}
                    </p>
                </div>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <div className="auth-card">
                <div className="auth-head">
                    <h1 className="auth-title">
                        {isReset ? "Reset your password" : "You're in"}
                    </h1>
                    <p className="auth-sub">
                        {isReset
                            ? "Choose a new password for your account. Use at least 8 characters, with letters and digits."
                            : "Your seat is set up. Choose a password so you can sign in again later. Use at least 8 characters, with letters and digits."}
                    </p>
                </div>
                <form className="auth-form" onSubmit={onSubmit}>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            minLength={8}
                            autoComplete="new-password"
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Confirm password</span>
                        <input
                            type="password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            minLength={8}
                            autoComplete="new-password"
                            required
                        />
                    </label>
                    {error && <p className="login-error">{error}</p>}
                    <div className="auth-actions">
                        <button
                            type="submit"
                            className="perform"
                            disabled={busy}
                        >
                            {busy ? "Saving…" : "Set password & continue"}
                        </button>
                        <Link href={dest} className="auth-skip">
                            I&apos;ll set this later
                        </Link>
                    </div>
                    <p className="hint">
                        You can always set or reset your password from the
                        sign-in page.
                    </p>
                </form>
            </div>
        </AuthShell>
    );
}

export default function WelcomePage() {
    return (
        <Suspense fallback={<main className="auth-shell" />}>
            <Welcome />
        </Suspense>
    );
}
