// My parts: back-link, title+subtitle head, summary line, search toolbar, count, then a table card.
import {
    Sk,
    SkBackLink,
    SkPageHead,
    SkToolbar,
    SkCount,
    SkRows,
} from "@/components/Skeletons";

export default function MePartsLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <Sk w={220} h={13} style={{ display: "block", margin: "10px 0" }} />
            <SkToolbar selects={2} />
            <SkCount />
            <div
                className="hub-table-card"
                style={{ padding: 0, overflow: "hidden" }}
            >
                <SkRows rows={8} cols={["46%", "16%", "12%"]} />
            </div>
        </main>
    );
}
