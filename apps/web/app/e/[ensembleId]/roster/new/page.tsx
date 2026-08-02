import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { MemberForm } from "@/components/MemberForm";

export const dynamic = "force-dynamic";

export default async function NewMemberPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const voicePartOptions = await repo.listVoiceParts();
    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/roster`} className="back-link">
                &larr; Roster
            </Link>
            <div className="page-head">
                <h1>Add singer</h1>
            </div>
            <MemberForm mode="create" voicePartOptions={voicePartOptions} />
        </main>
    );
}
