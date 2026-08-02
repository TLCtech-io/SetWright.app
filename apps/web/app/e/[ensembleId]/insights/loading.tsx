import { SkPageHead, SkCardGrid } from "@/components/Skeletons";

// Insights index: heading (no action), then the menu-card grid of insight tiles.
export default function InsightsLoading() {
    return (
        <main
            className="page hub-menu skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead />
            <SkCardGrid count={6} />
        </main>
    );
}
