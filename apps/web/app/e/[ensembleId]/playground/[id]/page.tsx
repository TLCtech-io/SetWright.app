import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { buildCoverage } from "@/lib/coverage";
import {
    PlaygroundBuilder,
    type RepertoireEntry,
} from "@/components/PlaygroundBuilder";

export const dynamic = "force-dynamic";

export default async function PlaygroundBuilderPage({
    params,
}: {
    params: Promise<{ ensembleId: string; id: string }>;
}) {
    const { ensembleId, id } = await params;
    const repo = getRepository();
    // The [id] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("program", id);
    const program = uuid ? await repo.getPlayground(uuid) : null;

    if (!uuid || !program) {
        return (
            <main className="page">
                <Link
                    href={`/e/${ensembleId}/playground`}
                    className="back-link"
                >
                    &larr; Playground
                </Link>
                <div className="page-head">
                    <h1>Program not found</h1>
                </div>
            </main>
        );
    }

    // Ship the repertoire with parts + castings so the builder computes seams and
    // auto-arrange client-side, with no event and no staffing. Confidence and the
    // director read are dropped: the seam logic reads only the featured lead
    // (is_primary), not the readiness penalty. All songs are shipped
    // (with an `active` flag), not just active ones, so a program keeps a song that
    // was archived after it was saved instead of silently losing it; the add picker
    // still offers only active songs.
    const songs = await repo.listSongs();
    // One batched read regrouped per song, instead of getSongParts + getSongCasting per song.
    const coverage = await buildCoverage(repo, songs);
    const repertoire: RepertoireEntry[] = coverage.map(
        ({ song: s, parts, castings }) => ({
            song: s,
            parts,
            castings: castings.map((c) => ({
                partId: c.partId,
                memberId: c.memberId,
                isPrimary: c.isPrimary,
                confidence: null,
                directorAssessed: null,
            })),
            active: s.status === "active",
        }),
    );
    const eventList = await repo.listEvents();
    const events = eventList.map((e) => ({ id: e.id, name: e.name }));

    return (
        <main className="page setlist-page">
            <Link href={`/e/${ensembleId}/playground`} className="back-link">
                &larr; Playground
            </Link>
            <PlaygroundBuilder
                program={program}
                repertoire={repertoire}
                events={events}
            />
        </main>
    );
}
