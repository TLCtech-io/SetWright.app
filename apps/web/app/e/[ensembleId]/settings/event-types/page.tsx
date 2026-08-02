import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { EventTypesManager } from "@/components/EventTypesManager";

// Reads mutable vocabulary state, so it renders per request.
export const dynamic = "force-dynamic";

export default async function EventTypesPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const initial = await repo.listEventTypes();
    const usage = await repo.eventTypeUsage();
    const profiles = await repo.listPaddingProfiles();
    const vocab = await repo.listTags();
    return (
        <main className="page vp-page">
            <Link href={`/e/${ensembleId}/settings`} className="back-link">
                &larr; Settings
            </Link>
            <div className="page-head">
                <div>
                    <h1>Event types</h1>
                    <div className="sub">
                        Reusable presets a new event is built from
                    </div>
                </div>
            </div>
            <p className="page-intro">
                An event type carries a default padding profile,
                on-book/explicit policy, and standing tag rules. Creating an
                event from a type (or clicking &quot;Apply defaults&quot;)
                copies those values onto the event &mdash; editing the type
                afterwards never changes existing events.
            </p>
            <EventTypesManager
                initial={initial}
                usage={usage}
                profiles={profiles}
                vocab={vocab}
            />
        </main>
    );
}
