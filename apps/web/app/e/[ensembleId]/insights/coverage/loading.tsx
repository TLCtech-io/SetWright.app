import { Sk, SkPageHead, SkBackLink, SkRows } from "@/components/Skeletons";

// The coverage report: back-link + head, one intro line, then a nis-group with a group head
// over a coverage table card. Reuses the real nis-group and coverage-card containers.
export default function CoverageLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />

            <Sk w={440} h={13} style={{ display: "block" }} />

            <div className="nis-group">
                <div className="nis-group-head">
                    <Sk w={120} h={16} />
                    <Sk w={24} h={16} />
                </div>
                <div
                    className="hub-table-card coverage-card"
                    style={{ padding: 0, overflow: "hidden" }}
                >
                    <SkRows rows={5} cols={["60%", "35%"]} />
                </div>
            </div>
        </main>
    );
}
