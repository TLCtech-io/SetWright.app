import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { gatherBehindSchedule } from "@/lib/prep";
import { formatEventDate, todayInTz } from "@/lib/format";

// Reads mutable state (prep targets, readiness, casting), so it renders per request.
export const dynamic = "force-dynamic";

export default async function BehindSchedulePage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const base = `/e/${ensembleId}`;
    const repo = getRepository();
    const today = todayInTz((await repo.getEnsembleSettings()).timezone);
    const rows = await gatherBehindSchedule(repo, today);
    // The rows carry song + gig uuids; the deep links need the URL tokens. Build uuid -> token
    // maps from the book and the events list (the same RLS-scoped reads those pages use).
    const [songs, events] = await Promise.all([
        repo.listSongs(),
        repo.listEvents(),
    ]);
    const songToken = new Map(songs.map((s) => [s.id, s.publicId]));
    const eventToken = new Map(events.map((e) => [e.id, e.publicId]));

    return (
        <main className="page reading-page">
            <Link href={`${base}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>Behind schedule</h1>
                    <div className="sub">
                        Targeted songs not ready for an upcoming gig
                    </div>
                </div>
            </div>
            <p className="page-intro">
                Songs a gig needs ready that are not yet performance-ready or
                fully cast, soonest deadline first. Set a gig&rsquo;s targets on
                its event page.
            </p>

            {rows.length === 0 ? (
                <p className="empty">
                    No upcoming gigs with target songs falling behind yet. Set a
                    gig&rsquo;s targets on its event page, and anything slipping
                    shows here.
                </p>
            ) : (
                <ul className="behind-list">
                    {rows.map((r) => (
                        <li key={r.songId} className="behind-row">
                            <div className="behind-main">
                                <Link
                                    href={`${base}/repertoire/${songToken.get(r.songId) ?? r.songId}`}
                                    className="behind-title"
                                >
                                    {r.title}
                                </Link>
                                <div className="behind-tags">
                                    {r.notReady && (
                                        <span className="prep-status not-ready">
                                            Not ready
                                        </span>
                                    )}
                                    {r.undercast && (
                                        <span className="prep-status undercast">
                                            Undercast
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="behind-due">
                                <span
                                    className={`behind-days${r.daysLeft <= 14 ? " urgent" : ""}`}
                                >
                                    {r.daysLeft === 0
                                        ? "due today"
                                        : `${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}`}
                                </span>
                                <Link
                                    href={`${base}/events/${eventToken.get(r.gigId) ?? r.gigId}`}
                                    className="behind-gig"
                                >
                                    {r.gigName}
                                    {formatEventDate(r.deadline)
                                        ? ` · ${formatEventDate(r.deadline)}`
                                        : ""}
                                </Link>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
