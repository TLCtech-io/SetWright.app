import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { formatSeconds, formatEventDate, todayInTz } from "@/lib/format";
import type { EventRow, SetlistMeta } from "@/lib/db";
import { EventsList, type EventListRow } from "@/components/EventsList";

// Reads mutable db state per request.
export const dynamic = "force-dynamic";

// The event's status pill, composed from the event flag + its setlists + RSVP state.
// (There is no single status field: cancelled/performed/finalized come from the event or
// its setlists; drafting-vs-awaiting from whether anyone still has to RSVP.)
function statusOf(
    e: EventRow,
    setlists: SetlistMeta[],
    undecided: boolean,
): { label: string; klass: string } {
    if (e.status === "cancelled")
        return { label: "Cancelled", klass: "neutral" };
    // A rehearsal is never drafted or performed, so the set-lifecycle states do not
    // apply; its status reads from RSVPs alone.
    if (e.kind === "rehearsal") {
        return undecided
            ? { label: "Awaiting RSVPs", klass: "warn" }
            : { label: "Scheduled", klass: "on" };
    }
    if (setlists.some((s) => s.status === "performed"))
        return { label: "Performed", klass: "good" };
    if (setlists.some((s) => s.status === "final"))
        return { label: "Finalized", klass: "good" };
    if (undecided) return { label: "Awaiting RSVPs", klass: "warn" };
    return { label: "Drafting", klass: "on" };
}

// Every event: date, venue, target, book/explicit policy, RSVP tally, and a derived status —
// the management list. The at-a-glance health lives on the Dashboard; this is the full roll.
// The table itself (search / sort / filter) is the client EventsList; the server just derives
// each row's display data.
export default async function EventsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const base = `/e/${ensembleId}`;
    const repo = getRepository();
    // Both kinds: the client list splits them into Gigs / Rehearsals tabs.
    const [events, roster] = await Promise.all([
        repo.listEvents({ kind: "all" }),
        repo.listRoster(),
    ]);

    // Active singing pool — matches the drafter's own pool so RSVP denominators line up.
    const singers = roster.filter((m) => m.singing && m.status === "active");
    const singerIds = new Set(singers.map((m) => m.id));

    // Per-event setlists drive the gig status pill. Rehearsals never own a setlist, so
    // skip the read for them (statusOf reads their status from RSVPs).
    const setlistsByEvent = new Map<string, SetlistMeta[]>(
        await Promise.all(
            events
                .filter((e) => e.kind === "gig")
                .map(
                    async (e) =>
                        [e.id, await repo.listEventSetlists(e.id)] as const,
                ),
        ),
    );

    // Day boundary in the ensemble's timezone, so the upcoming/past split matches the dashboard.
    const today = todayInTz((await repo.getEnsembleSettings()).timezone);

    // Derive each event's presentation row here; the client list only filters and sorts.
    const rows: EventListRow[] = events.map((e) => {
        const av = e.availability.filter((a) => singerIds.has(a.memberId));
        const inC = av.filter((a) => a.status === "in").length;
        const undecided =
            av.some((a) => a.status === "tentative") ||
            singers.length - av.length > 0;
        const status = statusOf(e, setlistsByEvent.get(e.id) ?? [], undecided);
        const cancelled = e.status === "cancelled";
        return {
            id: e.id,
            publicId: e.publicId,
            name: e.name,
            kind: e.kind,
            eventDate: e.resolved.eventDate,
            dateLabel:
                formatEventDate(e.resolved.eventDate, { year: true }) ??
                "No date",
            venue: e.venue ?? null,
            targetLabel:
                cancelled || e.resolved.targetDurationSeconds == null
                    ? "—"
                    : formatSeconds(e.resolved.targetDurationSeconds),
            allowsOnBook: e.resolved.allowsOnBook,
            cancelled,
            rsvpLabel: cancelled ? "—" : `${inC}/${singers.length}`,
            rsvpZero: !cancelled && inC === 0,
            statusLabel: status.label,
            statusKlass: status.klass,
        };
    });

    return (
        <main className="page">
            <div className="page-head">
                <div>
                    <h1>Events</h1>
                    <div className="sub">Gigs and rehearsals</div>
                </div>
                <div className="head-actions">
                    <Link
                        href={`${base}/events/new?kind=rehearsal`}
                        className="ctl"
                    >
                        + New rehearsal
                    </Link>
                    <Link href={`${base}/events/new`} className="perform">
                        + New event
                    </Link>
                </div>
            </div>

            <EventsList rows={rows} today={today} />
        </main>
    );
}
