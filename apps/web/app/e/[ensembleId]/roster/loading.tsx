import { SkPageHead, SkRosterGrid } from "@/components/Skeletons";

// Roster hub: heading + Add action, then the member card grid. Same shape as the live page.
export default function RosterLoading() {
    return (
        <main
            className="page hub skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead action />
            <SkRosterGrid />
        </main>
    );
}
