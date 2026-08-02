import Link from "next/link";
import { draftSetForEvent } from "@repertoire/api";
import { getSource } from "@/lib/source";
import { getRepository } from "@/lib/repository";
import { DraftView } from "@/components/DraftView";

// Drafts against mutable db state, so it renders per request.
export const dynamic = "force-dynamic";

// Draft through the same boundary the route uses (draftSetForEvent over getSource), but
// called directly server-side — no internal HTTP hop, so no host / x-forwarded-proto URL
// building (which is SSRF- and HTTPS-downgrade-fragile behind a proxy). getSource
// returns the per-request user client and this stays a direct call.
export default async function DraftPage({
    params,
}: {
    params: Promise<{ ensembleId: string; eventId: string }>;
}) {
    const { ensembleId, eventId } = await params;
    // The [eventId] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await getRepository().resolvePublicId("event", eventId);

    // The event must belong to this ensemble, and be a gig, before we draft. getEvent is
    // ensemble-scoped (the proxy-synced cookie), but draftSetForEvent hydrates through the
    // RLS-only source, which would otherwise let a multi-ensemble user draft another ensemble's
    // event under this URL. A missing event (wrong ensemble / non-member) or a rehearsal (no gig
    // set) both stop here, mirroring the draft route's guard.
    const ev = uuid ? await getRepository().getEvent(uuid) : null;
    if (!uuid || !ev || ev.kind !== "gig") {
        const notFound = !ev;
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>
                        {notFound
                            ? "Event not found"
                            : "Rehearsals are not drafted"}
                    </h1>
                </div>
                {notFound ? (
                    <p className="callout">
                        This event is not in this ensemble.
                    </p>
                ) : (
                    <>
                        <p className="callout">
                            A rehearsal has no gig set to fill. Open the
                            rehearsal to manage its RSVPs.
                        </p>
                        <Link
                            href={`/e/${ensembleId}/events/${eventId}`}
                            className="ctl"
                        >
                            Open the rehearsal
                        </Link>
                    </>
                )}
            </main>
        );
    }

    // A gig with no confirmed availability has no pool to draft from. Rather than run the drafter
    // to an empty set, nudge the director to gather RSVPs first. Availability is not seeded on
    // create, so a brand-new gig lands here until singers respond.
    if (
        !ev.availability.some(
            (a) => a.status === "in" || a.status === "tentative",
        )
    ) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Nothing to draft yet</h1>
                </div>
                <p className="callout">
                    No one has confirmed availability for {ev.name} yet, so
                    there is no pool to build a set from. Nudge your singers to
                    RSVP, then draft.
                </p>
                <Link
                    href={`/e/${ensembleId}/events/${eventId}`}
                    className="ctl"
                >
                    Open the event
                </Link>
            </main>
        );
    }

    // A brand-new director reaches the drafter before adding any songs. The drafter would return a
    // shortfall error; show a calm nudge to build the book first, not a bare error string.
    const activeBook = (await getRepository().listSongs()).filter(
        (s) => s.status === "active",
    );
    if (activeBook.length === 0) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Nothing to draft yet</h1>
                </div>
                <p className="callout">
                    The drafter builds from your book, and it&rsquo;s still
                    empty. Add a few performance-ready songs, then come back.
                </p>
                <Link href={`/e/${ensembleId}/repertoire`} className="ctl">
                    Go to repertoire
                </Link>
            </main>
        );
    }

    const res = await draftSetForEvent(getSource(), uuid);

    if (res.status !== 200) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Could not draft this event</h1>
                </div>
                <p className="callout shortfall">{res.body.error}.</p>
            </main>
        );
    }

    return <DraftView ensembleId={ensembleId} draft={res.body} />;
}
