import { SkPageHead, SkRows } from "@/components/Skeletons";

// The default skeleton for every page under /e/:ensembleId. Next shows it (streamed into the shell,
// under the persistent nav) the instant a route is requested, while that page's server component
// resolves its DB reads — so the wait is never a blank screen. Most surfaces are a heading over a
// list/table, so this generic shape fits them; the dashboard and repertoire have their own tailored
// skeletons that override this one.
export default function Loading() {
    return (
        <main
            className="page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkPageHead />
            <div
                className="hub-table-card"
                style={{ marginTop: 20, padding: 0, overflow: "hidden" }}
            >
                <SkRows rows={9} />
            </div>
        </main>
    );
}
