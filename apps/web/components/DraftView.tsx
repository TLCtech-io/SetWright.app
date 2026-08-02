import Link from "next/link";
import { songsOf, type DraftWithChase } from "@repertoire/core";
import { getRepository } from "@/lib/repository";
import { TimingBar } from "./TimingBar";
import { SetRail } from "./SetRail";
import { BalanceArc } from "./BalanceArc";
import { SetList } from "./SetList";
import { NotInSet } from "./NotInSet";

// The whole render payload, top to bottom. Reorder, pins (open/close/keep),
// exclude, and mark-performed map to setlist_item pins (via draftSetForSetlist) and
// the perform route (Repository.markPerformed -> perform_setlist). Read-only here.
export async function DraftView({
    ensembleId,
    draft,
}: {
    ensembleId: string;
    draft: DraftWithChase;
}) {
    const setSongs = songsOf(draft.set);
    const songCount = setSongs.length;
    // The reserve rows link to a song by uuid; NotInSet needs the URL token for each. Build the
    // uuid -> token map from the book (the same RLS-scoped read the repertoire list uses).
    const songToken = new Map(
        (await getRepository().listSongs()).map((s) => [s.id, s.publicId]),
    );

    return (
        <main className="page setlist-page">
            <Link href={`/e/${ensembleId}/events`} className="back-link">
                &larr; All events
            </Link>
            <div className="page-head">
                <div>
                    <h1>Draft set</h1>
                    <div className="sub">
                        {songCount} song{songCount === 1 ? "" : "s"}
                    </div>
                </div>
            </div>

            <TimingBar
                totalSeconds={draft.totalSeconds}
                targetSeconds={draft.targetSeconds}
            />

            <BalanceArc entries={setSongs} seams={draft.seams} />

            <div className="setlist-workspace">
                <div className="set-main">
                    <div className="module-head">
                        <h2 className="module-title">The set</h2>
                    </div>
                    <SetList set={setSongs} seams={draft.seams} />

                    {/* Read-only: a Server Component, so no handlers cross the client boundary; NotInSet
              renders the same grouped, searchable reserves without recovery actions. It sits in
              the primary column, under the set, so the reserves fill the space a short set would
              otherwise leave empty beside the rail. */}
                    <NotInSet
                        bench={draft.bench}
                        excluded={[]}
                        drops={draft.drops}
                        songToken={songToken}
                        prefix={`/e/${ensembleId}`}
                    />
                </div>

                <SetRail shortfall={draft.shortfall} chase={draft.chase} />
            </div>

            <p className="note">
                Read-only draft. Drag to reorder, pin the opener and closer,
                exclude songs, and mark the set performed come next.
            </p>
        </main>
    );
}
