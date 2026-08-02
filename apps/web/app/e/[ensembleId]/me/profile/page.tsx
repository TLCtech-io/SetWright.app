import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { getMyMembership } from "@/lib/ensembles";
import { MemberProfileForm } from "@/components/MemberProfileForm";
import { dataSource } from "@/lib/env";

export const dynamic = "force-dynamic";

// The member's own profile editor: display name and vocal range. Reads the signed-in
// member's record RLS-scoped to their ensemble; the form writes back through /me/profile.
export default async function MyProfilePage({
    params,
    searchParams,
}: {
    params: Promise<{ ensembleId: string }>;
    searchParams: Promise<{ email?: string }>;
}) {
    const { ensembleId } = await params;
    // /auth/confirm lands an email-change confirmation back here with ?email=changed. Acknowledge it
    // without over-promising: under double_confirm_changes both addresses confirm, so the change may
    // still be settling when the first link is clicked.
    const emailChanged = (await searchParams).email === "changed";
    const me = await getMyMembership(ensembleId);
    const member = me
        ? await getRepository().getMember(me.memberId)
        : undefined;

    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/me`} className="back-link">
                &larr; Your space
            </Link>
            <div className="page-head">
                <h1>Your profile</h1>
            </div>
            {emailChanged && (
                <p className="status" role="status">
                    Email change confirmed. If both your old and new address
                    need to confirm, the change takes effect once both are done.
                </p>
            )}
            {member ? (
                <MemberProfileForm
                    initial={member}
                    authEnabled={dataSource === "supabase"}
                />
            ) : (
                <p className="empty">
                    We couldn't find your membership in this ensemble.
                </p>
            )}
        </main>
    );
}
