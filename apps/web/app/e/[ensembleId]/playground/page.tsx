import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { NewPlaygroundButton } from "@/components/NewPlaygroundButton";
import { DeletePlaygroundButton } from "@/components/DeletePlaygroundButton";

export const dynamic = "force-dynamic";

// Saved programs, reachable directly without going through an event.
export default async function PlaygroundIndexPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const programs = await repo.listPlaygrounds();
    const songs = await repo.listSongs();
    const titleById = new Map(songs.map((s) => [s.id, s.title]));
    const assignedById = new Map(
        await Promise.all(
            programs.map(
                async (p) =>
                    [p.id, await repo.isPlaygroundAssigned(p.id)] as const,
            ),
        ),
    );

    return (
        <main className="page hub">
            <div className="page-head">
                <div>
                    <h1>Playground</h1>
                    <div className="sub">
                        Hand-built programs, arranged free of staffing
                    </div>
                </div>
                <NewPlaygroundButton />
            </div>

            {programs.length === 0 ? (
                <p className="empty">
                    No hand-built programs yet. Name one to start arranging
                    songs free of staffing.
                </p>
            ) : (
                <div className="rep-list rep-grid">
                    {programs.map((p) => {
                        const assigned = assignedById.get(p.id) ?? false;
                        return (
                            <div key={p.id} className="rep-row">
                                <div className="rep-body">
                                    <Link
                                        href={`/e/${ensembleId}/playground/${p.publicId}`}
                                        className="rep-title"
                                    >
                                        {p.name}
                                    </Link>
                                    <div className="rep-meta">
                                        {p.songIds.length} song
                                        {p.songIds.length === 1 ? "" : "s"}
                                        {p.songIds.length > 0 && (
                                            <>
                                                {" "}
                                                &middot;{" "}
                                                {p.songIds
                                                    .map(
                                                        (id) =>
                                                            titleById.get(id) ??
                                                            id,
                                                    )
                                                    .join(", ")}
                                            </>
                                        )}
                                        {assigned && (
                                            <> &middot; assigned to an event</>
                                        )}
                                    </div>
                                </div>
                                <div className="rep-actions">
                                    <DeletePlaygroundButton
                                        id={p.id}
                                        name={p.name}
                                        assigned={assigned}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </main>
    );
}
