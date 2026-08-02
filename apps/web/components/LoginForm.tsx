"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

// Email and password sign-in against Supabase auth, plus a password-reset link. On success it
// refreshes so server components re-read as the signed-in user.
export function LoginForm({ next = "/" }: { next?: string }) {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setNotice(null);
        const { error } = await browserClient().auth.signInWithPassword({
            email,
            password,
        });
        if (error) {
            setBusy(false);
            setError(error.message);
            return;
        }
        // The session cookie is set; return the user to where they were headed (validated app-relative
        // by the page), else the home resolver. Refresh so server components re-read as the user.
        router.push(next);
        router.refresh();
    }

    // Password reset. Also covers an account that never set a password (an invited member who skipped
    // it), since the same email lets them choose one. resetPasswordForEmail sends the recovery email,
    // whose link lands on /auth/confirm?type=recovery and then /auth/welcome to set a new password. The
    // response and notice are the same whether or not the address has an account, so a stranger cannot
    // probe which emails are registered.
    async function onForgot() {
        setError(null);
        setNotice(null);
        if (!email) {
            setError("Enter your email above first.");
            return;
        }
        setBusy(true);
        const { error } =
            await browserClient().auth.resetPasswordForEmail(email);
        setBusy(false);
        if (error) {
            setError(error.message);
            return;
        }
        setNotice(
            `If an account exists for ${email}, we sent a link to set a new password. Open it to choose one and sign in.`,
        );
    }

    return (
        <form className="auth-form" onSubmit={onSubmit}>
            <label className="field">
                <span>Email</span>
                <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
            </label>
            <label className="field">
                <span>Password</span>
                <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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
            <div className="auth-actions">
                <button type="submit" className="perform" disabled={busy}>
                    {busy ? "Signing in…" : "Sign in"}
                </button>
                <button
                    type="button"
                    className="auth-skip"
                    onClick={onForgot}
                    disabled={busy}
                >
                    Reset your password.
                </button>
            </div>
        </form>
    );
}
