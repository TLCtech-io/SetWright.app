import Link from "next/link";
import { redirect } from "next/navigation";
import { dataSource } from "@/lib/env";
import { publicSignupOpen } from "@/lib/signup";
import { serverClient } from "@/lib/supabase/server";
import { LoginForm } from "@/components/LoginForm";
import { AuthShell } from "@/components/AuthShell";
import { safeNext } from "@/lib/safeNext";

export const dynamic = "force-dynamic";

export default async function LoginPage({
    searchParams,
}: {
    searchParams: Promise<{ next?: string }>;
}) {
    const next = safeNext((await searchParams).next);
    // Mock mode has no auth — there is nothing to sign into.
    if (dataSource !== "supabase") redirect(next);
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next);

    return (
        <AuthShell
            footer={
                publicSignupOpen ? (
                    <>
                        New here? <Link href="/signup">Create an ensemble</Link>
                        .
                    </>
                ) : (
                    <>
                        SetWright is invite-only. Ask your director for an
                        invitation.
                    </>
                )
            }
        >
            <div className="auth-card">
                <div className="auth-head">
                    <h1 className="auth-title">Sign in</h1>
                    <p className="auth-sub">
                        Sign in to your ensemble to draft and manage sets.
                    </p>
                </div>
                <LoginForm next={next} />
            </div>
        </AuthShell>
    );
}
