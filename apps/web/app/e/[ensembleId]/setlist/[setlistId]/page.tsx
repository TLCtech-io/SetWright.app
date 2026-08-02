import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSetlist } from "@/lib/setlist";
import { getRepository } from "@/lib/repository";
import { SetlistView } from "@/components/SetlistView";
import { PerformedSetView } from "@/components/PerformedSetView";

// Reads mutable setlist state (and its concurrency token), so it renders per request.
export const dynamic = "force-dynamic";

// Load the initial draft + pins + catalog through the same boundary the route uses
// (loadSetlist), called directly server-side — no internal HTTP hop, so no host /
// x-forwarded-proto URL building. Then hand it to the interactive client view.
export default async function SetlistPage({
    params,
}: {
    params: Promise<{ ensembleId: string; setlistId: string }>;
}) {
    const { ensembleId, setlistId } = await params;
    const repo = getRepository();
    // The [setlistId] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("setlist", setlistId);
    if (!uuid) notFound();

    // A performed set is an immutable record: render it read-only from its frozen
    // order, never a fresh draft.
    const performed = await repo.getPerformedSet(uuid);
    if (performed) {
        const eventList = await repo.listEvents();
        const events = eventList.map((e) => ({ id: e.id, name: e.name }));
        return (
            <PerformedSetView
                performed={performed}
                events={events}
                ensembleId={ensembleId}
            />
        );
    }

    const res = await loadSetlist(repo, uuid);

    if (res.status !== 200) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Could not load this setlist</h1>
                </div>
                <p className="callout shortfall">
                    {res.status}: {res.body.error}
                </p>
            </main>
        );
    }

    // A finalized set renders locked (read-only editing + a "revert to draft" control).
    // getSetlistMeta also carries the optimistic-concurrency token for break edits.
    const meta = await repo.getSetlistMeta(uuid);
    if (!meta?.version) {
        // The setlist was deleted between loadSetlist and here (or has no token) — show the
        // not-found state rather than render with an empty token a break save would 400 on.
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Could not load this setlist</h1>
                </div>
            </main>
        );
    }
    return (
        <SetlistView
            initial={res.body}
            setlistPublicId={meta.publicId}
            locked={meta.status === "final"}
            publishedAt={meta.publishedAt}
            shareDraft={meta.shareDraft}
            version={meta.version}
        />
    );
}
