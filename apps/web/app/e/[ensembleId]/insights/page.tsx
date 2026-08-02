import Link from "next/link";
import { busFactor } from "@/lib/insights";
import { buildCoverage } from "@/lib/coverage";
import { soloistEquity } from "@/lib/equity";
import { gatherBehindSchedule } from "@/lib/prep";
import { todayInTz } from "@/lib/format";
import { getRepository } from "@/lib/repository";

// The Insights hub. Each report is its own page; each card previews the one number
// that says whether the report is worth opening right now.
export const dynamic = "force-dynamic";

export default async function InsightsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();

    const active = (await repo.listSongs()).filter(
        (s) => s.status === "active",
    );
    const members = await repo.listMembers();

    // Coverage: songs at risk (uncastable or one absence from dropping). Same read the
    // coverage page runs, for the count only. One batched read, not a query per song.
    const coverage = await buildCoverage(repo, active);
    const atRisk = busFactor(coverage, members).length;
    const learningCount = active.filter(
        (s) => s.assessedReadiness === "learning",
    ).length;
    const eventCount = (await repo.listEvents()).length;
    const performedCount = (await repo.getSetlistHistory()).length;
    const soloRows = soloistEquity(
        await repo.listSoloistAppearances(),
        members,
    );
    const neverSoloed = soloRows.filter(
        (r) => !r.departed && r.count === 0,
    ).length;
    const today = todayInTz((await repo.getEnsembleSettings()).timezone);
    const behindCount = (await gatherBehindSchedule(repo, today)).length;

    // A benign "0 at risk" on a fresh ensemble reads as all-clear when it is really no-data.
    // Each card carries a noData flag (the upstream input is empty), so its stat renders as a dim
    // em-dash rather than a green-looking zero. A book-derived report is no-data with no songs; the
    // performance reports are no-data with no events / no performed sets.
    const cards = [
        {
            href: "coverage",
            title: "Coverage risk",
            stat: `${atRisk} at risk`,
            warn: atRisk > 0,
            noData: active.length === 0,
            sub: "Songs that are one absence away from dropping, across the whole book.",
        },
        {
            href: "behind-schedule",
            title: "Behind schedule",
            stat: `${behindCount} behind`,
            warn: behindCount > 0,
            noData: active.length === 0,
            sub: "Songs targeted for an upcoming gig that are not yet ready or fully cast.",
        },
        {
            href: "what-if",
            title: "What-if planning",
            stat: `${eventCount} event${eventCount === 1 ? "" : "s"}`,
            warn: false,
            noData: eventCount === 0,
            sub: "Toggle availability for an event and see what breaks or unlocks.",
        },
        {
            href: "history",
            title: "Performed history",
            stat: `${performedCount} performed`,
            warn: false,
            noData: performedCount === 0,
            sub: "The archive of sets you have performed. Reopen one, or clone it as a starting point.",
        },
        {
            href: "learning",
            title: "Learning tracker",
            stat: `${learningCount} learning`,
            warn: false,
            noData: active.length === 0,
            sub: "For songs you are still learning, the covers you have not yet marked solid.",
        },
        {
            href: "soloists",
            title: "Soloist equity",
            stat: `${neverSoloed} never soloed`,
            warn: neverSoloed > 0,
            noData: performedCount === 0,
            sub: "Who has carried the solos across performed sets, and who has never had one.",
        },
    ];

    // Nothing built at all: name what fills these reports instead of six deceptive zeros.
    const allEmpty =
        active.length === 0 && eventCount === 0 && performedCount === 0;

    return (
        <main className="page hub-menu">
            <div className="page-head">
                <div>
                    <h1>Insights</h1>
                    <div className="sub">Coverage, planning, and history</div>
                </div>
            </div>

            {allEmpty && (
                <p className="page-intro">
                    These reports fill in as you build your book, cast parts,
                    and perform sets. Nothing to show yet.
                </p>
            )}

            <div className="cards">
                {cards.map((c) => (
                    <Link
                        key={c.href}
                        href={`/e/${ensembleId}/insights/${c.href}`}
                        className="card"
                    >
                        <div className="card-head">
                            <span className="card-title">{c.title}</span>
                            <span
                                className={`card-stat${c.noData ? " none" : c.warn ? " warn" : ""}`}
                            >
                                {c.noData ? "—" : c.stat}
                            </span>
                        </div>
                        <div className="card-sub">{c.sub}</div>
                    </Link>
                ))}
            </div>
        </main>
    );
}
