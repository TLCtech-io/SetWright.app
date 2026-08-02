import Link from "next/link";
import type { AvailabilityStatus } from "@repertoire/core";
import { toCoverage } from "@/lib/insights";
import { getRepository } from "@/lib/repository";
import { WhatIfPanel, type WhatIfMember } from "@/components/WhatIfPanel";

export const dynamic = "force-dynamic";

// Hydrate the event the same way the drafter sees it (active songs, the singing
// pool, that event's RSVPs), then hand the coverage and current availability to
// the client panel.
export default async function WhatIfPage({
    params,
}: {
    params: Promise<{ ensembleId: string; eventId: string }>;
}) {
    const repo = getRepository();
    const { ensembleId, eventId } = await params;
    // The [eventId] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("event", eventId);
    const payload = uuid ? await repo.hydratePayload(uuid) : null;
    const event = uuid ? await repo.getEvent(uuid) : null;

    if (!payload || !event) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/insights`} className="back-link">
                    &larr; Insights
                </Link>
                <div className="page-head">
                    <h1>Event not found</h1>
                </div>
            </main>
        );
    }

    // What-if simulates a gig set's coverage; a rehearsal has no set. Guard the by-id
    // page (reachable by direct URL) the same way the draft page guards itself.
    if (event.kind !== "gig") {
        return (
            <main className="page">
                <Link
                    href={`/e/${ensembleId}/insights/what-if`}
                    className="back-link"
                >
                    &larr; What-if planning
                </Link>
                <div className="page-head">
                    <h1>Not available for a rehearsal</h1>
                </div>
                <p className="callout">
                    What-if coverage runs on a gig set. Open the rehearsal to
                    manage its RSVPs.
                </p>
                <Link
                    href={`/e/${ensembleId}/events/${eventId}`}
                    className="ctl"
                >
                    Open the rehearsal
                </Link>
            </main>
        );
    }

    const coverage = toCoverage(payload.songs, payload.parts, payload.castings);
    const statusById = new Map<string, AvailabilityStatus>(
        payload.availability.map((a) => [a.memberId, a.status]),
    );
    // A pool member with no RSVP hasn't confirmed, so default to tentative (not
    // counted as available).
    const members: WhatIfMember[] = payload.members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        status: statusById.get(m.id) ?? "tentative",
    }));

    return (
        <main className="page">
            <Link
                href={`/e/${ensembleId}/insights/what-if`}
                className="back-link"
            >
                &larr; What-if planning
            </Link>
            <div className="page-head">
                <div>
                    <h1>What-if: {event.name}</h1>
                    <div className="sub">Coverage if availability changes</div>
                </div>
            </div>
            <WhatIfPanel members={members} coverage={coverage} />
        </main>
    );
}
