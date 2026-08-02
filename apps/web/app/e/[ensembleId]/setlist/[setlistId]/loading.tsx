import { SkSetlistWorkspace } from "@/components/Skeletons";

// Setlist workspace: the draft shape with a head action (publish/edit).
export default function SetlistLoading() {
    return (
        <main
            className="page setlist-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkSetlistWorkspace action />
        </main>
    );
}
