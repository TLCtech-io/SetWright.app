import { SkBackLink, SkPageHead, SkFormCard } from "@/components/Skeletons";

// The song detail: back-link, title + Edit/Cast action, and the two detail cards (metadata + parts).
export default function RepertoireDetailLoading() {
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
            <SkFormCard fields={2} />
        </main>
    );
}
