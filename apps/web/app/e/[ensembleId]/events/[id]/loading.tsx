import { SkBackLink, SkPageHead, SkFormCard } from "@/components/Skeletons";

// The event detail's top form region: back-link, title + delete action, and the edit fields. The
// page forks by role below this, so only the shared top form is masked.
export default function EventLoading() {
    return (
        <main
            className="page form-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead action />
            <SkFormCard fields={2} />
        </main>
    );
}
