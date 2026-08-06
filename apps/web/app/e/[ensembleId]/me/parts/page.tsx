import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { getMyMembership } from "@/lib/ensembles";
import { MyParts } from "@/components/MyParts";

export const dynamic = "force-dynamic";

export default async function MyPartsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const me = await getMyMembership(ensembleId);
    // The member's own range sizes a solo line against what they can actually sing; coverage tells
    // them whether each part has backup (and who else covers it). Settings carry the ensemble's
    // confidence visibility, which decides who the line below can honestly promise sees the read.
    const [parts, member, coverage, settings] = await Promise.all([
        repo.listMyCastings(),
        me ? repo.getMember(me.memberId) : Promise.resolve(undefined),
        repo.listMyPartCoverage(),
        repo.getEnsembleSettings(),
    ]);

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/me`} className="back-link">
                &larr; Your space
            </Link>
            <div className="page-head">
                <div>
                    <h1>Your parts</h1>
                    <div className="sub">
                        The songs you&rsquo;re cast on, weakest first. Open a
                        part for its pitch, key, and tempo, and set how solid
                        you feel.{" "}
                        {settings.confidenceVisibility === "shared"
                            ? "Your whole group sees your read, not just your director."
                            : "Only you and your director see your read."}
                    </div>
                </div>
            </div>
            {parts.length ? (
                <MyParts
                    parts={parts}
                    memberLow={member?.rangeLowMidi ?? null}
                    memberHigh={member?.rangeHighMidi ?? null}
                    coverage={coverage}
                />
            ) : (
                <div className="empty">
                    <p>
                        You&rsquo;re not cast on any songs yet. When your
                        director casts you, your parts show up here with the
                        pitch, key, and tempo to practice.
                    </p>
                    <Link
                        href={`/e/${ensembleId}/me/songs`}
                        className="empty-cta"
                    >
                        Browse the book &rarr;
                    </Link>
                </div>
            )}
        </main>
    );
}
