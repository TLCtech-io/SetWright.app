import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { ResendInviteForm } from "@/components/ResendInviteForm";
import { countPendingInvitations } from "@/lib/ensembles";

export const dynamic = "force-dynamic";

// Where a signed-in account that belongs to no ensemble lands (an invitation that expired, or was verified
// under a different address so it bound no seat). It explains the situation, offers a fresh invite link
// (sent only if a seat is still waiting), and a way to sign out. Wired from /auth/confirm's no-ensemble
// destination and the welcome page's no-ensemble fallback.
//
// An invitation that is actually waiting makes this page's whole story wrong, and it became reachable in
// that state once seats stopped binding automatically: someone who signed in with a password rather than
// a link has an invitation and no membership at the same time. Send them to the decision instead of
// telling them their invitation probably expired.
export default async function NoAccessPage() {
    if ((await countPendingInvitations()) > 0) redirect("/auth/invitations");
    return renderNoAccess();
}

function renderNoAccess() {
    return (
        <AuthShell
            footer={
                <form action="/auth/signout" method="post">
                    <button type="submit" className="ctl auth-signout">
                        Sign out
                    </button>
                </form>
            }
        >
            <div className="auth-card">
                <div className="auth-head">
                    <h1 className="auth-title">
                        You don&apos;t have access yet
                    </h1>
                    <p className="auth-sub">
                        You&apos;re signed in, but you don&apos;t belong to an
                        ensemble yet. Your invitation may have expired, or it
                        was sent to a different address. If a seat is still
                        waiting for you, request a fresh link below.
                    </p>
                </div>
                <ResendInviteForm />
            </div>
        </AuthShell>
    );
}
