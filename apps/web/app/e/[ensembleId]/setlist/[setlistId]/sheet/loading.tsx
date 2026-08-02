import { SkBackLink, SkPageHead, SkRows } from "@/components/Skeletons";

// Sheet is a table page. It needs its own loader so the setlist workspace
// loader one level up does not cascade onto it.
export default function SheetLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <div className="sheet">
                <SkPageHead />
                <div
                    className="hub-table-card sheet-card"
                    style={{ padding: 0, overflow: "hidden" }}
                >
                    <SkRows
                        rows={10}
                        cols={["8%", "44%", "14%", "20%", "14%"]}
                    />
                </div>
            </div>
        </main>
    );
}
