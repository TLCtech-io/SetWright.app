"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";

// New-director signup: creates the Supabase auth account, then the member sets up their ensemble
// after confirming their email. Collects display name, ensemble name, email, and password.
export function SignupForm() {
    const router = useRouter();
    const [displayName, setDisplayName] = useState("");
    const [ensembleName, setEnsembleName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Synchronous re-entry guard: `disabled` commits a tick late, so a fast double-submit fires two
    // signUp calls (and, on a confirmation-off deployment, two seeded ensembles). A ref flips
    // immediately, so the second call bails.
    const pending = useRef(false);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        setNotice(null);
        const supabase = browserClient();
        const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
            email,
            password,
            // pending_ensemble_name rides in user_metadata so it survives the email-confirmation gap:
            // there is no session yet to create the ensemble, so /auth/confirm seeds it once the confirm
            // link establishes one. See apps/web/app/auth/confirm/route.ts. Both are capped at 80 to
            // match lib/ensembleSettingsInput.ts: metadata travels inside the access token on every
            // request, and pending_ensemble_name also reaches the confirmation email.
            options: {
                data: {
                    display_name: displayName.trim().slice(0, 80),
                    pending_ensemble_name: ensembleName.trim().slice(0, 80),
                },
            },
        });
        if (signUpErr) {
            pending.current = false;
            setBusy(false);
            setError(signUpErr.message);
            return;
        }
        // When email confirmation is required, signUp returns NO session yet — the create-ensemble
        // RPC would fail (not authenticated). Tell them to confirm; they set up their ensemble from
        // Your ensembles after signing in. Only when confirmation is off (a session is returned) do
        // we create the seeded ensemble inline.
        if (!signUp.session) {
            pending.current = false;
            setBusy(false);
            // Honest for both cases without leaking which one it is (GoTrue returns the same obfuscated
            // success for an already-registered email and sends nothing, to prevent account enumeration):
            // don't promise an email will arrive or that the ensemble is set up.
            setNotice(
                `Almost there. Check your email to finish setting up ${ensembleName.trim()}. If no message arrives shortly, you may already have an account — try signing in instead.`,
            );
            return;
        }
        const { data: newId, error: rpcErr } = await supabase.rpc(
            "create_ensemble_seeded",
            {
                p_name: ensembleName,
                p_display_name: displayName,
            },
        );
        if (rpcErr || !newId) {
            pending.current = false;
            setBusy(false);
            setError(
                "Account created, but the ensemble could not be set up. Create one from Your ensembles.",
            );
            return;
        }
        // The URL carries the ensemble's public token, never its uuid. The RPC returns the uuid, so
        // resolve the token for the new ensemble (the founder is now its director, so the read passes).
        const { data: created } = await supabase
            .from("ensemble")
            .select("public_id")
            .eq("id", newId)
            .single();
        pending.current = false;
        setBusy(false);
        const token = created?.public_id;
        if (!token) {
            setError(
                "Account created, but the ensemble could not be set up. Create one from Your ensembles.",
            );
            return;
        }
        // The proxy sets the active-ensemble cookie as this route loads.
        router.push(`/e/${token}/dashboard`);
        router.refresh();
    }

    return (
        <form className="auth-form" onSubmit={onSubmit}>
            <label className="field">
                <span>Your name</span>
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
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                />
                <span className="hint">
                    At least 8 characters, with letters and digits.
                </span>
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
                {busy ? "Creating…" : "Create account"}
            </button>
        </form>
    );
}
