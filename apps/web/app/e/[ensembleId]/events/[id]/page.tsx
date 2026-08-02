import Link from "next/link";
import type { MemberRow } from "@/lib/db";
import { getRepository } from "@/lib/repository";
import { getMyMembership } from "@/lib/ensembles";
import { buildCallSheetView } from "@/lib/callSheet";
import { EventForm } from "@/components/EventForm";
import { RsvpEditor } from "@/components/RsvpEditor";
import { SetlistManager } from "@/components/SetlistManager";
import { RehearsalAgenda } from "@/components/RehearsalAgenda";
import { RehearsalRecord } from "@/components/RehearsalRecord";
import { PrepTargets } from "@/components/PrepTargets";
import { DeleteEventButton } from "@/components/DeleteEventButton";
import { MemberCallSheet } from "@/components/MemberCallSheet";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import {
    buildRehearsalAgendaView,
    buildRehearsalRecordView,
} from "@/lib/rehearsalView";
import { buildPrepView } from "@/lib/prep";
import { formatEventDate, todayInTz } from "@/lib/format";

// Reads mutable db state per request (the event plus the tag/type vocabularies).
export const dynamic = "force-dynamic";

export default async function EventDetailPage({
    params,
}: {
    params: Promise<{ ensembleId: string; id: string }>;
}) {
    const repo = getRepository();
    const { ensembleId, id } = await params;
    // The [id] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("event", id);
    const [event, me] = await Promise.all([
        uuid ? repo.getEvent(uuid) : Promise.resolve(undefined),
        getMyMembership(ensembleId),
    ]);

    if (!uuid || !event) {
        return (
            <main className="page form-page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; Events
                </Link>
                <div className="page-head">
                    <h1>Event not found</h1>
                </div>
            </main>
        );
    }

    // Shared, role-branched route: a member sees a read-only call sheet; the director gets
    // the management console below. The proxy lets a member reach this exact path; the tier check here
    // is the authority for what renders. A null membership (should not happen for a rendered page —
    // the proxy admits only active members) falls through to the director view, whose RLS-scoped reads
    // would return nothing for a non-member anyway.
    if (me && me.tier !== "director") {
        const view = await buildCallSheetView(repo, event, me);
        return <MemberCallSheet ensembleId={ensembleId} view={view} />;
    }

    const tags = await repo.listTags();
    const eventTypes = await repo.listEventTypes();
    const presets = await repo.eventTypePresets();
    // Setlists are gig-only; a rehearsal gets its agenda instead. Skip the read for a rehearsal.
    const eventSetlists =
        event.kind === "gig" ? await repo.listEventSetlists(uuid) : [];
    const roster = await repo.listRoster();
    const voiceParts = await repo.listVoiceParts();
    const agendaView =
        event.kind === "rehearsal"
            ? await buildRehearsalAgendaView(repo, event)
            : null;
    // The ensemble-tz today is the fallback stamp for a date-TBD rehearsal record (resolved here, not
    // in the browser's UTC). Only needed for a rehearsal.
    const recordView =
        event.kind === "rehearsal"
            ? await buildRehearsalRecordView(
                  repo,
                  event,
                  todayInTz((await repo.getEnsembleSettings()).timezone),
              )
            : null;
    const prepView =
        event.kind === "gig" ? await buildPrepView(repo, event) : null;

    // RSVP pool: active singers, grouped by home section (same grouping as the Event roster).
    const singers = roster.filter((m) => m.status === "active" && m.singing);
    const homeOf = (m: MemberRow) =>
        m.sections.find((s) => s.isPrimary)?.voicePartId ?? null;
    const rsvpGroups = voiceParts
        .map((vp) => ({
            label: vp.label,
            members: singers
                .filter((m) => homeOf(m) === vp.id)
                .map((m) => ({ id: m.id, displayName: m.displayName })),
        }))
        .filter((g) => g.members.length > 0);
    const unassigned = singers
        .filter((m) => homeOf(m) === null)
        .map((m) => ({ id: m.id, displayName: m.displayName }));
    if (unassigned.length > 0)
        rsvpGroups.push({ label: "No home section", members: unassigned });

    // Collapsed-section hints: an at-a-glance summary in each card header, so the director can
    // read the state of the whole page without opening anything. The event date rides the
    // Event-details header, so it stays visible at the top even collapsed.
    const inN = event.availability.filter((a) => a.status === "in").length;
    const outN = event.availability.filter((a) => a.status === "out").length;
    const tentN = event.availability.filter(
        (a) => a.status === "tentative",
    ).length;
    const rsvpHint =
        event.availability.length === 0
            ? "No RSVPs yet"
            : `${inN} in · ${outN} out${tentN > 0 ? ` · ${tentN} maybe` : ""}`;
    const dateHint = event.resolved.eventDate
        ? formatEventDate(event.resolved.eventDate)
        : "Date TBD";
    const count = (n: number, one: string, many: string) =>
        `${n} ${n === 1 ? one : many}`;

    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/events`} className="back-link">
                &larr; Events
            </Link>
            <div className="page-head narrow">
                <div>
                    <h1>{event.name}</h1>
                    {event.kind === "rehearsal" && (
                        <div className="sub">Rehearsal</div>
                    )}
                </div>
                <div className="head-actions">
                    <DeleteEventButton id={uuid} />
                </div>
            </div>

            <div className="section-stack">
                <CollapsibleSection label="Event details" hint={dateHint}>
                    <EventForm
                        mode="edit"
                        eventId={uuid}
                        vocab={tags}
                        eventTypes={eventTypes}
                        presets={presets}
                        initial={event}
                    />
                </CollapsibleSection>

                {/* Setlists and the draft preview are gig-only; a rehearsal shows its agenda in the
            same slot. Both hang off the event's RSVPs below. */}
                {event.kind === "gig" && (
                    <>
                        <CollapsibleSection
                            label="Setlists"
                            hint={count(
                                eventSetlists.length,
                                "setlist",
                                "setlists",
                            )}
                        >
                            <SetlistManager
                                eventId={uuid}
                                setlists={eventSetlists}
                            />
                        </CollapsibleSection>
                        {prepView && (
                            <CollapsibleSection
                                label="Prep targets"
                                hint={
                                    prepView.targetIds.length === 0
                                        ? "None set"
                                        : count(
                                              prepView.targetIds.length,
                                              "target",
                                              "targets",
                                          )
                                }
                                /* The cross-gig roll-up of what is still behind for an upcoming date. */
                                action={
                                    <Link
                                        href={`/e/${ensembleId}/insights/behind-schedule`}
                                        className="section-action"
                                    >
                                        Behind schedule →
                                    </Link>
                                }
                            >
                                <PrepTargets eventId={uuid} view={prepView} />
                            </CollapsibleSection>
                        )}
                    </>
                )}
                {event.kind === "rehearsal" && agendaView && (
                    <CollapsibleSection
                        label="Rehearsal agenda"
                        hint={
                            agendaView.saved.length === 0
                                ? "Empty"
                                : count(
                                      agendaView.saved.length,
                                      "song",
                                      "songs",
                                  )
                        }
                    >
                        <RehearsalAgenda eventId={uuid} view={agendaView} />
                    </CollapsibleSection>
                )}

                <CollapsibleSection
                    label="RSVPs"
                    hint={rsvpHint}
                    /* The section-grouped attendance view of these same RSVPs. */
                    action={
                        <Link
                            href={`/e/${ensembleId}/events/${id}/roster`}
                            className="section-action"
                        >
                            Event roster →
                        </Link>
                    }
                >
                    <RsvpEditor
                        eventId={uuid}
                        groups={rsvpGroups}
                        initial={event.availability}
                        version={event.version ?? ""}
                    />
                </CollapsibleSection>

                {/* Record what actually happened: the fact after the plan (agenda) and the intent (RSVPs). */}
                {event.kind === "rehearsal" && recordView && (
                    <CollapsibleSection
                        label="Record rehearsal"
                        hint={recordView.recorded ? "Recorded" : "Not recorded"}
                    >
                        <RehearsalRecord eventId={uuid} view={recordView} />
                    </CollapsibleSection>
                )}
            </div>
        </main>
    );
}
