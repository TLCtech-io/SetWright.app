import Link from "next/link";
import { busFactor } from "@/lib/insights";
import { buildCoverage } from "@/lib/coverage";
import { getRepository } from "@/lib/repository";
import { BusFactorReport } from "@/components/BusFactorReport";

// Reads mutable db state (songs, casting, roster), so it renders per request.
export const dynamic = "force-dynamic";

// Coverage risk is repertoire-wide, so it reads the active book and the singing
// roster directly.
export default async function CoveragePage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const active = (await repo.listSongs()).filter(
        (s) => s.status === "active",
    );
    const coverage = await buildCoverage(repo, active); // one batched read, not a query per song
    const pool = await repo.listMembers(); // active, singing members: the coverage pool
    const rows = busFactor(coverage, pool);
    // Song uuid -> URL token, so each risk row can link to the casting screen by token.
    const songToken = new Map(active.map((s) => [s.id, s.publicId]));

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/insights`} className="back-link">
                &larr; Insights
            </Link>
            <div className="page-head">
                <div>
                    <h1>Coverage risk</h1>
                    <div className="sub">
                        Single points of failure across the book
                    </div>
                </div>
            </div>
            <p className="page-intro">
                Which songs are fragile if a singer is out. Based on who is
                cast, not who could learn a part. Pool: {pool.length} singing
                member{pool.length === 1 ? "" : "s"}.
            </p>
            <BusFactorReport
                rows={rows}
                songCount={active.length}
                songToken={songToken}
                prefix={`/e/${ensembleId}`}
            />
        </main>
    );
}
