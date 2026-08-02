import { SkBackLink, SkPageHead, Sk } from "@/components/Skeletons";

// Casting: back-link, head, then three parts each with two cover rows.
export default function CastingLoading() {
    return (
        <main
            className="page casting-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <div className="casting">
                {[0, 1, 2].map((i) => (
                    <div className="cast-part" key={i}>
                        <div className="cast-part-head">
                            <Sk w={120} h={16} />
                            <Sk w={70} h={13} />
                        </div>
                        <div className="cast-cover">
                            <Sk w={150} h={14} />
                            <Sk w={90} h={24} r={9} />
                        </div>
                        <div className="cast-cover">
                            <Sk w={150} h={14} />
                            <Sk w={90} h={24} r={9} />
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}
