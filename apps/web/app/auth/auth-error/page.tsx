import Link from "next/link";
import { AuthShell } from "@/components/AuthShell";
import { ResendInviteForm } from "@/components/ResendInviteForm";

// Shown when /auth/confirm couldn't verify a token (a link that was already used, expired, or malformed).
// Recovery is self-serve: request a fresh invitation link (sent only if a seat is still waiting), or sign
// in if the account already exists.
export default function AuthErrorPage() {
    return (
        <AuthShell
            footer={
                <>
                    Already have an account? <Link href="/login">Sign in</Link>.
                </>
            }
        >
            <div className="auth-card">
                <div className="auth-head">
                    <h1 className="auth-title">This link didn&apos;t work</h1>
                    <p className="auth-sub">
                        Your invitation or sign-in link is invalid or has
                        expired. Links can only be used once. If a seat is still
                        waiting for you, request a fresh link below.
                    </p>
                </div>
                <ResendInviteForm />
            </div>
        </AuthShell>
    );
}
