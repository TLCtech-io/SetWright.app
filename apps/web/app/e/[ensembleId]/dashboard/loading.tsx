import { Sk } from "@/components/Skeletons";

// The dashboard's tailored skeleton: the hero, the three health stat-cards, and the two panels,
// shaped like the real page so the swap to content barely shifts. Shown while the dashboard resolves
// its reads (events, roster, coverage, the next set's draft) — the heaviest page in the console.
export default function DashboardLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <section className="hub-hero">
                <div className="hub-hero-main">
                    <Sk w={90} h={11} />
                    <Sk w={260} h={34} style={{ marginTop: 12 }} />
                    <Sk w={180} h={13} style={{ marginTop: 12 }} />
                </div>
                <div className="hub-hero-avail">
                    <Sk w={80} h={11} />
                    <Sk w={72} h={40} style={{ marginTop: 12 }} />
                    <Sk w={150} h={12} style={{ marginTop: 10 }} />
                </div>
                <div className="hub-hero-aside">
                    <Sk w="100%" h={52} r={12} />
                    <Sk w={130} h={38} r={9} style={{ marginTop: 14 }} />
                </div>
            </section>

            <div className="skeleton-cards">
                {[0, 1, 2].map((i) => (
                    <div className="stat-card" key={i}>
                        <Sk w={80} h={11} />
                        <Sk w={110} h={26} style={{ marginTop: 14 }} />
                        <Sk w="100%" h={12} style={{ marginTop: 16 }} />
                    </div>
                ))}
            </div>

            <div className="dash-panels">
                {[0, 1].map((i) => (
                    <section className="panel" key={i}>
                        <Sk w={150} h={20} />
                        <Sk w="100%" h={14} style={{ marginTop: 18 }} />
                        <Sk w="100%" h={14} style={{ marginTop: 12 }} />
                        <Sk w="75%" h={14} style={{ marginTop: 12 }} />
                    </section>
                ))}
            </div>
        </main>
    );
}
