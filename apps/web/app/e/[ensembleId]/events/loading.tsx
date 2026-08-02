// Events hub: title+action head, tabs strip, search toolbar, count, then a table card.
import {
    Sk,
    SkPageHead,
    SkToolbar,
    SkCount,
    SkRows,
} from "@/components/Skeletons";

export default function EventsLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead action />
            <div className="tabs">
                <Sk w={90} h={38} r={9} />
                <Sk w={110} h={38} r={9} />
            </div>
            <SkToolbar selects={2} />
            <SkCount />
            <div
                className="hub-table-card"
                style={{ padding: 0, overflow: "hidden" }}
            >
                <SkRows
                    rows={9}
                    cols={["30%", "16%", "10%", "10%", "8%", "14%"]}
                />
            </div>
        </main>
    );
}
