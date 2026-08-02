import { Sk, SkPageHead, SkBackLink } from "@/components/Skeletons";

// The what-if index: back-link + head, then a rep-list of event rows, each a title over a meta line.
export default function WhatIfLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />

            <div className="rep-list">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div className="rep-row" key={i}>
                        <div className="rep-body">
                            <Sk w={200} h={15} />
                            <Sk w={120} h={11} style={{ marginTop: 8 }} />
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}
