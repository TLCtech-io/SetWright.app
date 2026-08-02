import { SkBackLink, SkPageHead, SkRosterGrid } from "@/components/Skeletons";

// Member roster view: back-link, heading (no action), then the member card grid.
export default function MeRosterLoading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <SkRosterGrid cards={[4, 3, 4]} />
        </main>
    );
}
