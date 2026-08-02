import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { getMyMembership } from "@/lib/ensembles";
import { formatEventDate, formatSeconds, todayInTz } from "@/lib/format";
import {
    attendanceGroups,
    type AttendanceMember,
} from "@/lib/attendanceGroups";
import { MySchedule, type MyEventRsvp } from "@/components/MySchedule";

export const dynamic = "force-dynamic";

export default async function MySchedulePage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const me = await getMyMembership(ensembleId);
    // Members RSVP to rehearsals too, so this schedule shows both kinds (labeled). The roster +
    // section vocab feed the "who's coming" grouping; event types name each gig.
    const [events, roster, voiceParts, eventTypes, settings] =
        await Promise.all([
            repo.listEvents({ kind: "all" }),
            repo.listRoster(),
            repo.listVoiceParts(),
            repo.listEventTypes(),
            repo.getEnsembleSettings(),
        ]);
    // The ensemble's day boundary, so upcoming vs past matches the rest of the app.
    const today = todayInTz(settings.timezone);

    const typeName = new Map(eventTypes.map((t) => [t.id, t.name]));
    // The active singing pool — the same pool the drafter and the director's RSVP tally use, so the
    // who's-coming roll matches. Projected to the safe fields the grouping reads; nothing else about
    // a peer (invite email, self-confidence) ever leaves the server.
    const pool: AttendanceMember[] = roster
        .filter((m) => m.singing && m.status === "active")
        .map((m) => ({
            id: m.id,
            displayName: m.displayName,
            sections: m.sections,
        }));

    // Cancelled events are struck, not dropped, so a member sees the change on their own schedule.
    const rows: MyEventRsvp[] = events
        .map((e) => ({
            id: e.id,
            publicId: e.publicId,
            name: e.name,
            kind: e.kind,
            date: e.resolved.eventDate ?? null,
            dateLabel:
                formatEventDate(e.resolved.eventDate, { year: true }) ??
                "Date TBD",
            status: me
                ? (e.availability.find((a) => a.memberId === me.memberId)
                      ?.status ?? null)
                : null,
            cancelled: e.status === "cancelled",
            venue: e.venue ?? null,
            eventType: e.eventTypeId
                ? (typeName.get(e.eventTypeId) ?? null)
                : null,
            // Labelled "target" so the m:ss set length is not misread as a start time (the row carries
            // no time of day). Matches the "Target" vocabulary on the director's event surfaces.
            targetLabel:
                e.resolved.targetDurationSeconds != null
                    ? `target ${formatSeconds(e.resolved.targetDurationSeconds)}`
                    : null,
            allowsOnBook: e.resolved.allowsOnBook,
            allowsExplicit: e.resolved.allowsExplicit,
            groups: attendanceGroups(e.availability, pool, voiceParts),
        }))
        // Display order (upcoming first) is decided in MySchedule, which owns the sort control and has
        // today. Keep a stable base order here.
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/me`} className="back-link">
                &larr; Your space
            </Link>
            <div className="page-head">
                <div>
                    <h1>Your schedule</h1>
                    <div className="sub">
                        Gigs and rehearsals. Let your director know whether you
                        can make each one, and see who else is coming.
                    </div>
                </div>
            </div>
            {rows.length ? (
                <MySchedule events={rows} today={today} />
            ) : (
                <p className="empty">
                    No events are scheduled yet. When your director adds a gig
                    or rehearsal, you&rsquo;ll RSVP right here.
                </p>
            )}
        </main>
    );
}
