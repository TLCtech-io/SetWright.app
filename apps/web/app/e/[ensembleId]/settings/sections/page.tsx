import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { SectionsManager } from "@/components/SectionsManager";

// Reads mutable vocabulary state, so it renders per request.
export const dynamic = "force-dynamic";

export default async function SectionsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const voiceParts = await repo.listVoiceParts();
    const usage = await repo.voicePartUsage();

    return (
        <main className="page vp-page">
            <Link href={`/e/${ensembleId}/settings`} className="back-link">
                &larr; Settings
            </Link>
            <div className="page-head">
                <div>
                    <h1>Sections</h1>
                    <div className="sub">
                        The voice-part vocabulary singers and charts draw from
                    </div>
                </div>
            </div>
            <p className="page-intro">
                Sections order the roster and label the parts a song needs. A
                section a chart still calls for can&apos;t be deleted until
                those parts are reassigned; members linked to a deleted section
                simply lose it.
            </p>
            <SectionsManager initial={voiceParts} usage={usage} />
        </main>
    );
}
