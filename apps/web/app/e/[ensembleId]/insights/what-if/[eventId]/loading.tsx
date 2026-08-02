import { Sk, SkBackLink } from "@/components/Skeletons";

// The what-if scenario detail: back-link + a wider title-only head, then the whatif two-column: a
// roster of members each with three toggles, and a result panel with a verdict + note.
export default function WhatIfEventLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <div className="page-head">
                <div>
                    <Sk w={260} h={30} />
                </div>
            </div>

            <div className="whatif">
                <div className="whatif-roster">
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div className="whatif-member" key={i}>
                            <Sk w={140} h={14} />
                            <div className="whatif-toggles">
                                {Array.from({ length: 3 }).map((_, j) => (
                                    <Sk key={j} w={48} h={30} r={9} />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="whatif-result">
                    <Sk w={80} h={28} />
                    <Sk w={120} h={13} style={{ marginTop: 10 }} />
                </div>
            </div>
        </main>
    );
}
