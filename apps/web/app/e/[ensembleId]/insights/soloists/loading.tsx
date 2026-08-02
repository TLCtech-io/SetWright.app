import { Sk, SkPageHead, SkBackLink } from "@/components/Skeletons";

// The soloists equity report: back-link + head, one intro line, then an equity list of rows, each a
// name + a track holding a bar + a count. The bar width varies per row so it does not read as uniform.
export default function SoloistsLoading() {
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

            <div className="equity">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div className="equity-row" key={i}>
                        <Sk w={120} h={14} />
                        <div className="equity-track">
                            <Sk w={String(30 + i * 8) + "%"} h={14} r={7} />
                        </div>
                        <Sk w={20} h={14} />
                    </div>
                ))}
            </div>
        </main>
    );
}
