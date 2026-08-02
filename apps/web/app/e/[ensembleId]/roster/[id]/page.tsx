import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { MemberForm } from "@/components/MemberForm";
import { InviteControl } from "@/components/InviteControl";

// Reads mutable member state (and the invite claim state), so it renders per request.
export const dynamic = "force-dynamic";

export default async function EditMemberPage({
    params,
}: {
    params: Promise<{ ensembleId: string; id: string }>;
}) {
    const repo = getRepository();
    const { ensembleId, id } = await params;
    // The [id] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("member", id);
    const member = uuid ? await repo.getMember(uuid) : null;

    if (!uuid || !member) {
        return (
            <main className="page form-page">
                <Link href={`/e/${ensembleId}/roster`} className="back-link">
                    &larr; Roster
                </Link>
                <div className="page-head">
                    <h1>Singer not found</h1>
                </div>
            </main>
        );
    }

    const voicePartOptions = await repo.listVoiceParts();

    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/roster`} className="back-link">
                &larr; Roster
            </Link>
            <div className="page-head">
                <h1>Edit singer</h1>
            </div>
            <MemberForm
                mode="edit"
                memberId={uuid}
                voicePartOptions={voicePartOptions}
                initial={member}
            />
            <InviteControl
                ensembleId={ensembleId}
                memberId={uuid}
                claimed={member.claimed}
                inviteEmail={member.inviteEmail}
            />
        </main>
    );
}
