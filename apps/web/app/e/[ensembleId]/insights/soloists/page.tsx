import Link from "next/link";
import { soloistEquity } from "@/lib/equity";
import { getRepository } from "@/lib/repository";
import { SoloistEquity } from "@/components/SoloistEquity";

export const dynamic = "force-dynamic";

// Soloist equity view: who has taken solos and how often, so the director can see how
// features are spread and even them out. Tallies solo appearances against the roster.
export default async function SoloistsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const appearances = await repo.listSoloistAppearances();
    const rows = soloistEquity(appearances, await repo.listMembers());
    const total = appearances.length;

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>Soloist equity</h1>
                    <div className="sub">
                        Who has carried the solos, across performed sets
                    </div>
                </div>
            </div>
            <p className="page-intro">
                Counted from who actually soloed at each performance ({total}{" "}
                solo{total === 1 ? "" : "s"} on record), not the current
                casting. Mark sets performed to build the picture.
            </p>
            <SoloistEquity rows={rows} hasPerformed={total > 0} />
        </main>
    );
}
