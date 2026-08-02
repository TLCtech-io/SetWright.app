import Link from "next/link";
import { redirect } from "next/navigation";
import { dataSource } from "@/lib/env";
import { publicSignupOpen } from "@/lib/signup";
import { serverClient } from "@/lib/supabase/server";
import { SignupForm } from "@/components/SignupForm";
import { AuthShell } from "@/components/AuthShell";

export const dynamic = "force-dynamic";

// The account-creation page. Only meaningful in supabase mode, so it redirects home otherwise; an
// already-signed-in user is sent home too. Public registration is closed by default (invite-only); when
// PUBLIC_SIGNUP reopens it, the form renders. See lib/signup.ts.
export default async function SignupPage() {
    if (dataSource !== "supabase") redirect("/");
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect("/");

    if (!publicSignupOpen) {
        return (
            <AuthShell
                footer={
                    <>
                        Already have an account?{" "}
                        <Link href="/login">Sign in</Link>.
                    </>
                }
            >
                <div className="auth-card">
                    <div className="auth-head">
                        <h1 className="auth-title">SetWright is invite-only</h1>
                        <p className="auth-sub">
                            New accounts are by invitation right now. Ask your
                            director for an invitation, or contact us for
                            access.
                        </p>
                    </div>
                </div>
            </AuthShell>
        );
    }

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
                    <h1 className="auth-title">Create your ensemble</h1>
                    <p className="auth-sub">
                        Start a new ensemble. You’ll be its director, with a
                        starter set of voice parts, tags, and event types ready
                        to go.
                    </p>
                </div>
                <SignupForm />
            </div>
        </AuthShell>
    );
}
