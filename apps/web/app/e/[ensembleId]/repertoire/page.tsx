import Link from "next/link";
import { getRepository } from "@/lib/repository";
import {
    RepertoireList,
    type RepertoireItem,
} from "@/components/RepertoireList";

// Reads mutable db state, so it must render per request rather than prerender
// static (which would never reflect created/edited/archived songs).
export const dynamic = "force-dynamic";

export default async function RepertoirePage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    // Part count per song comes from ONE batched read of the book's parts (getEnsembleCoverage),
    // tallied in memory — not a getSongParts query per song. The client list does no db reads.
    const [songs, coverage] = await Promise.all([
        repo.listSongs(),
        repo.getEnsembleCoverage(),
    ]);
    const partCountBySong = new Map<string, number>();
    for (const p of coverage.parts)
        partCountBySong.set(p.songId, (partCountBySong.get(p.songId) ?? 0) + 1);
    const items: RepertoireItem[] = songs.map((s) => ({
        ...s,
        partCount: partCountBySong.get(s.id) ?? 0,
    }));
    const activeCount = items.filter((s) => s.status === "active").length;
    const tagRows = await repo.listTags();
    const tags = tagRows.map((t) => t.name);

    return (
        <main className="page hub">
            <div className="page-head">
                <div>
                    <h1>Repertoire</h1>
                    <div className="sub">
                        {activeCount} song{activeCount === 1 ? "" : "s"} in the
                        active book
                    </div>
                </div>
                <Link
                    href={`/e/${ensembleId}/repertoire/new`}
                    className="perform"
                >
                    + Add song
                </Link>
            </div>

            <RepertoireList items={items} tags={tags} />
        </main>
    );
}
