import { Sk, SkPageHead, SkRows } from "@/components/Skeletons";

// The repertoire's tailored skeleton: the heading + Add action, the search/sort/filter toolbar, the
// result count, and the song table. Shaped like the real list so the swap barely shifts.
export default function RepertoireLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead action />

            <div className="songs-toolbar">
                <Sk w="100%" h={40} r={9} style={{ maxWidth: 360 }} />
                <div className="songs-controls">
                    <Sk w={130} h={38} r={9} />
                    <Sk w={110} h={38} r={9} />
                </div>
            </div>

            <Sk w={120} h={11} style={{ margin: "4px 2px 12px" }} />

            <div
                className="hub-table-card songs-card"
                style={{ padding: 0, overflow: "hidden" }}
            >
                <SkRows
                    rows={10}
                    cols={["34%", "10%", "10%", "10%", "14%", "10%"]}
                />
            </div>
        </main>
    );
}
