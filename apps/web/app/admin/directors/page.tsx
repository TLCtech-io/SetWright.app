import Link from "next/link";
import { redirect } from "next/navigation";
import { dataSource } from "@/lib/env";
import { serverClient } from "@/lib/supabase/server";
import { AuthShell } from "@/components/AuthShell";
import { AdminDirectorInviteForm } from "@/components/AdminDirectorInviteForm";

export const dynamic = "force-dynamic";

// The platform-admin console: invite a new director and authorize their first ensemble. The perimeter
// proxy already gates /admin to platform admins; this re-checks server-side (defense in depth) and
// redirects anyone else, so the page never renders for a non-admin even if the middleware were bypassed.
export default async function AdminDirectorsPage() {
    if (dataSource !== "supabase") redirect("/");
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    const { data: isAdmin } = await supabase.rpc("auth_is_platform_admin");
    if (isAdmin !== true) redirect("/");

    return (
        <AuthShell
            footer={
                <>
                    <Link href="/">Back to the app</Link>. Platform admin.
                </>
            }
        >
            <div className="auth-card">
                <div className="auth-head">
                    <h1 className="auth-title">Invite a director</h1>
                    <p className="auth-sub">
                        Send a new director their invite and authorize their
                        first ensemble. You name the ensemble and the director;
                        they set a password when they accept, then land inside
                        their new ensemble.
                    </p>
                </div>
                <AdminDirectorInviteForm />
            </div>
        </AuthShell>
    );
}
