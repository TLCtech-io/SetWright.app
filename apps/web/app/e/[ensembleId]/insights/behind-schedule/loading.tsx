import { Sk, SkPageHead, SkBackLink } from "@/components/Skeletons";

// The behind-schedule report: back-link + head, two intro lines, then the behind-list of rows.
// Each row pairs a title + two status pills on the left with a due chip + note on the right.
export default function BehindScheduleLoading() {
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
            <Sk w={300} h={13} style={{ display: "block", marginTop: 8 }} />

            <ul className="behind-list">
                {Array.from({ length: 6 }).map((_, i) => (
                    <li className="behind-row" key={i}>
                        <div className="behind-main">
                            <Sk w={170} h={15} />
                            <Sk w={64} h={18} r={9} />
                            <Sk w={64} h={18} r={9} />
                        </div>
                        <div className="behind-due">
                            <Sk w={70} h={16} r={9} />
                            <Sk w={180} h={13} />
                        </div>
                    </li>
                ))}
            </ul>
        </main>
    );
}
