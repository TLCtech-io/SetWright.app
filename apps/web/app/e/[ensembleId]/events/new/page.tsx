import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { EventForm } from "@/components/EventForm";

// Reads the now-mutable tag vocabulary, so it must render per request (a build-time
// prerender would freeze the context-tag pickers to the seed tags).
export const dynamic = "force-dynamic";

export default async function NewEventPage({
    params,
    searchParams,
}: {
    params: Promise<{ ensembleId: string }>;
    searchParams: Promise<{ kind?: string }>;
}) {
    const { ensembleId } = await params;
    const isRehearsal = (await searchParams).kind === "rehearsal";
    const repo = getRepository();
    const tags = await repo.listTags();
    const eventTypes = await repo.listEventTypes();
    const presets = await repo.eventTypePresets();
    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/events`} className="back-link">
                &larr; Events
            </Link>
            <div className="page-head">
                <h1>{isRehearsal ? "New rehearsal" : "New event"}</h1>
            </div>
            <EventForm
                mode="create"
                vocab={tags}
                eventTypes={eventTypes}
                presets={presets}
                initialKind={isRehearsal ? "rehearsal" : "gig"}
            />
        </main>
    );
}
