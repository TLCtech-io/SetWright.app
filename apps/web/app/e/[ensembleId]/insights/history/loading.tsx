import { Sk, SkPageHead, SkBackLink } from "@/components/Skeletons";

// The history report: back-link + head, then three hist-sections, each a heading + intro over a
// rep-list of song rows (title + a longer meta line).
export default function HistoryLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />

            {Array.from({ length: 3 }).map((_, s) => (
                <section className="hist-section" key={s}>
                    <Sk w={220} h={18} />
                    <Sk
                        w={380}
                        h={13}
                        style={{ display: "block", marginTop: 10 }}
                    />
                    <div className="rep-list">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <div className="rep-row" key={i}>
                                <div className="rep-body">
                                    <Sk w={200} h={15} />
                                    <Sk
                                        w={300}
                                        h={11}
                                        style={{ marginTop: 8 }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </main>
    );
}
