import { SkBackLink, SkPageHead, SkRosterGrid } from "@/components/Skeletons";

// Event attendance hub: back-link, heading + Edit RSVPs action, then the attendance card grid.
export default function EventRosterLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead action />
            <SkRosterGrid cards={[3, 3, 3, 3]} />
        </main>
    );
}
