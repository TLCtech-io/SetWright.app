import Link from "next/link";
import type { MemberSong } from "@/components/MemberRepertoire";
import { getRepository } from "@/lib/repository";
import { MemberRepertoire } from "@/components/MemberRepertoire";

// Reads mutable db state (the book plus its tags), so render per request.
export const dynamic = "force-dynamic";

// A read-only browse of the active book. Lets a member learn songs beyond
// their own castings and gives a new member a low-stakes way to see the group's style. listSongs is
// RLS-scoped to the member's ensemble; the projection below strips it to the member-safe descriptive
// fields (no planning signals, no casting, no director-private data).
export default async function MemberSongsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const songs = await repo.listSongs();

    const items: MemberSong[] = songs
        .filter((s) => s.status === "active")
        .map((s) => ({
            id: s.id,
            title: s.title,
            arranger: s.arranger,
            chartRef: s.chartRef,
            startKey: s.startKey,
            endKey: s.endKey,
            startTempoBpm: s.startTempoBpm,
            endTempoBpm: s.endTempoBpm,
            durationSeconds: s.durationSeconds,
            intensity: s.intensity,
            isExplicit: s.isExplicit,
            onBook: s.bookStatus === "on-book",
            assessedReadiness: s.assessedReadiness,
            tags: s.tags.map((t) => t.name),
        }));
    // The tags actually used in the active book, so the filter chips carry no dead options.
    const tags = [...new Set(items.flatMap((s) => s.tags))].sort((a, b) =>
        a.localeCompare(b),
    );

    return (
        <main className="page hub">
            <Link href={`/e/${ensembleId}/me`} className="back-link">
                &larr; Your space
            </Link>
            <div className="page-head">
                <div>
                    <h1>Repertoire</h1>
                    <div className="sub">
                        {`${items.length} song${items.length === 1 ? "" : "s"} in the active book. Browse the group’s music.`}
                    </div>
                </div>
            </div>

            <MemberRepertoire items={items} tags={tags} />
        </main>
    );
}
