import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { todayInTz } from "@/lib/format";
import { CloneSetButton } from "@/components/CloneSetButton";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
    Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const STALE_AFTER_DAYS = 90;

// The recency page. Two song lists the dashboard's Recency card links into: songs
// not performed in 90+ days (stale, #not-performed) and performance-ready songs not
// rehearsed in 90+ days (gone cold, #not-rehearsed). The performed archive follows.
export default async function HistoryPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const [history, eventList, songs, settings] = await Promise.all([
        repo.getSetlistHistory(),
        repo.listEvents(),
        repo.listSongs(),
        repo.getEnsembleSettings(),
    ]);
    const events = eventList.map((e) => ({ id: e.id, name: e.name }));
    const today = todayInTz(settings.timezone);
    const active = songs.filter((s) => s.status === "active");

    // Not performed in 90+ days (or never). Never-performed first, then oldest.
    const notPerformed = active
        .filter(
            (s) =>
                !s.lastPerformed ||
                daysBetween(s.lastPerformed, today) > STALE_AFTER_DAYS,
        )
        .sort((a, b) => {
            if (!a.lastPerformed && !b.lastPerformed)
                return a.title.localeCompare(b.title);
            if (!a.lastPerformed) return -1;
            if (!b.lastPerformed) return 1;
            return a.lastPerformed < b.lastPerformed ? -1 : 1;
        });

    // Gone cold: performance-ready songs not rehearsed in 90+ days. A never-rehearsed
    // song carries no signal (null = unknown), matching the drafter. Most stale first.
    const notRehearsed = active
        .filter(
            (s) =>
                s.assessedReadiness === "performance-ready" &&
                !!s.lastRehearsed &&
                daysBetween(s.lastRehearsed, today) > STALE_AFTER_DAYS,
        )
        .sort((a, b) => (a.lastRehearsed! < b.lastRehearsed! ? -1 : 1));

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>Recency</h1>
                    <div className="sub">
                        Songs going stale or cold, and what you have performed
                    </div>
                </div>
            </div>

            <section id="not-performed" className="hist-section">
                <h2 className="panel-title">Not performed in 90+ days</h2>
                <p className="page-intro">
                    {notPerformed.length} active song
                    {notPerformed.length === 1 ? "" : "s"} not performed in the
                    last 90 days (or never). Candidates to refresh or retire.
                </p>
                {notPerformed.length === 0 ? (
                    <p className="empty">
                        {active.length === 0
                            ? "No songs in the book yet."
                            : "Every song has been performed within the last 90 days."}
                    </p>
                ) : (
                    <div className="rep-list">
                        {notPerformed.map((s) => (
                            <div key={s.id} className="history-row">
                                <div className="rep-title">
                                    <Link
                                        href={`/e/${ensembleId}/repertoire/${s.publicId}`}
                                    >
                                        {s.title}
                                    </Link>
                                </div>
                                <div className="rep-meta">
                                    {s.lastPerformed
                                        ? `last performed ${s.lastPerformed} · ${daysBetween(s.lastPerformed, today)} days ago`
                                        : "never performed"}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section id="not-rehearsed" className="hist-section">
                <h2 className="panel-title">Not rehearsed in 90+ days</h2>
                <p className="page-intro">
                    {notRehearsed.length} performance-ready song
                    {notRehearsed.length === 1 ? "" : "s"} gone cold. Give{" "}
                    {notRehearsed.length === 1 ? "it" : "them"} a run before you
                    lean on {notRehearsed.length === 1 ? "it" : "them"}.
                </p>
                {notRehearsed.length === 0 ? (
                    <p className="empty">
                        {active.length === 0
                            ? "No songs in the book yet."
                            : "Every performance-ready song has been rehearsed within the last 90 days."}
                    </p>
                ) : (
                    <div className="rep-list">
                        {notRehearsed.map((s) => (
                            <div key={s.id} className="history-row">
                                <div className="rep-title">
                                    <Link
                                        href={`/e/${ensembleId}/repertoire/${s.publicId}`}
                                    >
                                        {s.title}
                                    </Link>
                                </div>
                                <div className="rep-meta">
                                    last rehearsed {s.lastRehearsed} ·{" "}
                                    {daysBetween(s.lastRehearsed!, today)} days
                                    ago
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section className="hist-section">
                <h2 className="panel-title">Performed history</h2>
                {history.length === 0 ? (
                    <p className="empty">
                        No performed sets yet. Mark a set performed to start the
                        archive.
                    </p>
                ) : (
                    <div className="rep-list">
                        {history.map((h) => (
                            <div key={h.setlistId} className="history-row">
                                <div className="rep-title">
                                    <Link
                                        href={`/e/${ensembleId}/setlist/${h.setlistPublicId}`}
                                    >
                                        {h.eventName}
                                    </Link>
                                    {h.name ? (
                                        <span className="rep-meta">
                                            {" "}
                                            &middot; {h.name}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="rep-meta">
                                    {h.date} &middot; {h.titles.length} song
                                    {h.titles.length === 1
                                        ? ""
                                        : "s"} &middot; {h.titles.join(", ")}
                                </div>
                                <CloneSetButton
                                    setlistId={h.setlistId}
                                    events={events}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </main>
    );
}
