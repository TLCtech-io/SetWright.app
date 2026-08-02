// My schedule: back-link, title+subtitle head, toolbar, count, then a list of scheduled items with RSVP buttons.
import {
    Sk,
    SkBackLink,
    SkPageHead,
    SkToolbar,
    SkCount,
} from "@/components/Skeletons";

export default function MeScheduleLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <SkToolbar selects={2} />
            <SkCount />
            <div className="rep-list">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div className="sched-item" key={i}>
                        <div className="rep-row">
                            <div>
                                <Sk w="55%" h={15} />
                                <Sk w="70%" h={12} style={{ marginTop: 8 }} />
                            </div>
                            <div>
                                <Sk w={48} h={32} r={8} />
                                <Sk w={48} h={32} r={8} />
                                <Sk w={48} h={32} r={8} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}
