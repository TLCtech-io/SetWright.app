import { SkSetlistWorkspace } from "@/components/Skeletons";

// Draft workspace: back-link + head + timing bar + arc + two-column body.
// SkSetlistWorkspace carries its own back-link and head.
export default function DraftLoading() {
    return (
        <main
            className="page setlist-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkSetlistWorkspace />
        </main>
    );
}
