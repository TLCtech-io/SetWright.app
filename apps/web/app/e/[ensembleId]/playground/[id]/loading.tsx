import { SkSetlistWorkspace } from "@/components/Skeletons";

// Playground workspace: same shape as draft, with a head action and the library column.
export default function PlaygroundLoading() {
    return (
        <main
            className="page setlist-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkSetlistWorkspace action library />
        </main>
    );
}
