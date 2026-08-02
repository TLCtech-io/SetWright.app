import Link from "next/link";
import type { LearningSong } from "@/lib/learning";

// Three distinct director states: shaky (some work), learning (still developing),
// and unassessed (no read formed yet) read differently at a glance.
const ASSESS_TONE: Record<string, string> = {
    shaky: "polish",
    learning: "learn",
    unassessed: "low",
};

// Presentational. Each learning song lists the covers the director has not marked
// solid, with a link to that song's casting screen to assess them.
export function LearningTracker({
    rows,
    ensembleId,
    songToken,
    learningCount,
}: {
    rows: LearningSong[];
    ensembleId: string;
    // Song uuid -> URL token. The rows carry song uuids; the casting deep link needs the token.
    songToken: Map<string, string>;
    // How many songs are marked 'learning' at all, so "no data yet" reads apart from "all solid".
    learningCount: number;
}) {
    if (rows.length === 0) {
        return (
            <p className="empty">
                {learningCount === 0
                    ? "No songs marked learning yet. Set a song to learning and this tracks the covers you have not rated solid."
                    : "Nothing to woodshed: every cover on your learning songs is marked solid."}
            </p>
        );
    }

    return (
        <div className="rep-list">
            {rows.map((song) => (
                <div key={song.songId} className="learning-row">
                    <div className="learning-head">
                        <span className="rep-title">{song.title}</span>
                        <Link
                            href={`/e/${ensembleId}/repertoire/${songToken.get(song.songId) ?? song.songId}/casting`}
                            className="ctl"
                        >
                            Cast
                        </Link>
                    </div>
                    <div className="learning-covers">
                        {song.covers.map((c) => (
                            <div
                                key={`${c.memberId}:${c.partId}`}
                                className="learning-cover"
                            >
                                <span className="cover-name">
                                    {c.displayName}
                                </span>
                                <span className="rep-meta">{c.partLabel}</span>
                                <span
                                    className={`badge ${ASSESS_TONE[c.assessed ?? "unassessed"]}`}
                                >
                                    {c.assessed ?? "unassessed"}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
