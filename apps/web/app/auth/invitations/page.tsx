import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import {
    InvitationList,
    type PendingInvitation,
} from "@/components/InvitationList";
import { serverClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Where an invited person decides whether to join. Nothing binds a seat to an account before this
// screen: /auth/confirm used to claim every matching invitation the moment any link was verified, of
// any kind, so a director who knew an address could put someone in their ensemble without ever asking.
//
// The proxy treats every /auth/* path as public, so this page guards its own session rather than
// assuming one. It also reads through list_pending_invitations, a definer function, because an invitee
// holds no member row yet: member_read, ensemble_read and member_invite_read all resolve to nothing for
// them, so without it there would be no ensemble name to show and no seat to name.
export default async function InvitationsPage() {
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const { data, error } = await supabase.rpc("list_pending_invitations");
    if (error) {
        console.error(
            "[invitations] list_pending_invitations failed:",
            error.message,
        );
    }
    const invitations: PendingInvitation[] = (
        (data ?? []) as {
            ensemble_id: string;
            ensemble_name: string;
            seat_name: string;
        }[]
    ).map((r) => ({
        ensembleId: r.ensemble_id,
        ensembleName: r.ensemble_name,
        seatName: r.seat_name,
    }));

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
                        {invitations.length > 0
                            ? "You have been invited"
                            : "Nothing is waiting for you"}
                    </h1>
                    <p className="auth-sub">
                        {invitations.length > 0
                            ? "Joining is your choice. Accept the ones you want; declining lets the director know the seat is free."
                            : "You have no invitations right now. An invitation appears here once a director sends one to this address."}
                    </p>
                </div>
                {invitations.length > 0 ? (
                    <InvitationList invitations={invitations} />
                ) : (
                    <p className="auth-skip">
                        <Link href="/">Continue</Link>
                    </p>
                )}
            </div>
        </AuthShell>
    );
}
