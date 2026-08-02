import Link from "next/link";
import { getRepository } from "@/lib/repository";

export const dynamic = "force-dynamic";

// What-if is per event: pick one to simulate its availability.
export default async function WhatIfLandingPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const events = await repo.listEvents();

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>What-if planning</h1>
                    <div className="sub">
                        See what breaks or unlocks as availability changes
                    </div>
                </div>
            </div>

            {events.length === 0 ? (
                <div className="empty">
                    <p>
                        No events to simulate yet. Create an event, then toggle
                        availability to see what breaks or unlocks.
                    </p>
                    <Link
                        href={`/e/${ensembleId}/events/new`}
                        className="empty-cta"
                    >
                        Create an event &rarr;
                    </Link>
                </div>
            ) : (
                <div className="rep-list">
                    {events.map((e) => (
                        <div key={e.id} className="rep-row">
                            <div className="rep-body">
                                <Link
                                    href={`/e/${ensembleId}/insights/what-if/${e.publicId}`}
                                    className="rep-title"
                                >
                                    {e.name}
                                </Link>
                                <div className="rep-meta">
                                    {e.venue ?? "no venue"}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </main>
    );
}
