import Link from "next/link";
import { learningTracker, type SongAssess } from "@/lib/learning";
import { buildCoverage } from "@/lib/coverage";
import { getRepository } from "@/lib/repository";
import { LearningTracker } from "@/components/LearningTracker";

export const dynamic = "force-dynamic";

export default async function LearningPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const active = (await repo.listSongs()).filter(
        (s) => s.status === "active",
    );
    // One batched read regrouped per song, instead of getSongParts + getSongCasting per song.
    const coverage = await buildCoverage(repo, active);
    const songs: SongAssess[] = coverage.map(
        ({ song: s, parts, castings }) => ({
            song: {
                id: s.id,
                title: s.title,
                assessedReadiness: s.assessedReadiness,
            },
            parts: parts.map((p) => ({ id: p.id, label: p.label })),
            castings: castings.map((c) => ({
                partId: c.partId,
                memberId: c.memberId,
                directorAssessed: c.directorAssessed,
            })),
        }),
    );
    const nameById = new Map(
        (await repo.listRoster()).map((m) => [m.id, m.displayName]),
    );
    const rows = learningTracker(songs, nameById);
    // Song uuid -> URL token, so each learning row can link to the casting screen by token.
    const songToken = new Map(active.map((s) => [s.id, s.publicId]));
    const learningCount = active.filter(
        (s) => s.assessedReadiness === "learning",
    ).length;

    return (
        <main className="page reading-page">
            <Link href={`/e/${ensembleId}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>Learning tracker</h1>
                    <div className="sub">Who still needs to woodshed</div>
                </div>
            </div>
            <p className="page-intro">
                For the {learningCount} song{learningCount === 1 ? "" : "s"}{" "}
                marked &lsquo;learning&rsquo;, the covers you have not yet
                assessed as solid. This is your own read, not the singer&rsquo;s
                self-report; set each cover&rsquo;s &lsquo;your read&rsquo; in
                the song&rsquo;s Cast screen.
            </p>
            <LearningTracker
                rows={rows}
                ensembleId={ensembleId}
                songToken={songToken}
                learningCount={learningCount}
            />
        </main>
    );
}
