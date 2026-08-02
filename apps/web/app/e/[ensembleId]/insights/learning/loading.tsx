import { Sk, SkPageHead, SkBackLink } from "@/components/Skeletons";

// The learning report (reading-page variant): back-link + head, two intro lines, then a rep-list of
// learning rows, each a head (title + action) over a covers row of three label + pill groups.
export default function LearningLoading() {
    return (
        <main
            className="page reading-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />

            <Sk w={440} h={13} style={{ display: "block" }} />
            <Sk w={300} h={13} style={{ display: "block", marginTop: 8 }} />

            <div className="rep-list">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div className="learning-row" key={i}>
                        <div className="learning-head">
                            <Sk w={160} h={16} />
                            <Sk w={54} h={30} r={9} />
                        </div>
                        <div className="learning-covers">
                            {Array.from({ length: 3 }).map((_, j) => (
                                <div key={j}>
                                    <Sk w={90} h={13} />
                                    <Sk w={70} h={20} r={9} />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}
