// My songs: back-link, title-only head, search+chips toolbar, count, then a wide songs table card.
import {
    SkBackLink,
    SkPageHead,
    SkToolbar,
    SkCount,
    SkRows,
} from "@/components/Skeletons";

export default function MeSongsLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <SkToolbar selects={1} chips={5} />
            <SkCount />
            <div
                className="hub-table-card songs-card"
                style={{ padding: 0, overflow: "hidden" }}
            >
                <SkRows
                    rows={10}
                    cols={["30%", "10%", "10%", "10%", "12%", "14%", "12%"]}
                />
            </div>
        </main>
    );
}
