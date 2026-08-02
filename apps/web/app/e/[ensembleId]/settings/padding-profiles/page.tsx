import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { PaddingProfilesManager } from "@/components/PaddingProfilesManager";

// Reads mutable vocabulary state, so it renders per request.
export const dynamic = "force-dynamic";

export default async function PaddingProfilesPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const profiles = await repo.listPaddingProfiles();
    const usage = await repo.paddingProfileUsage();

    return (
        <main className="page vp-page">
            <Link href={`/e/${ensembleId}/settings`} className="back-link">
                &larr; Settings
            </Link>
            <div className="page-head">
                <div>
                    <h1>Padding profiles</h1>
                    <div className="sub">
                        Reusable time-overhead presets for event types
                    </div>
                </div>
            </div>
            <p className="page-intro">
                A padding profile is the per-song gap and one-time overhead an
                event type stamps onto a new event. Deleting one leaves its
                event types on the default padding; existing events keep their
                snapshot.
            </p>
            <PaddingProfilesManager initial={profiles} usage={usage} />
        </main>
    );
}
