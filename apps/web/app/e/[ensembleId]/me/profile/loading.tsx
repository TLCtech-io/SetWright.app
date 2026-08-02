import { Sk, SkBackLink, SkFormCard } from "@/components/Skeletons";

// The member profile edit: back-link, a title-only head, and the profile card. The optional password
// card is not masked; it renders below on its own.
export default function MeProfileLoading() {
    return (
        <main
            className="page form-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <div className="page-head">
                <div>
                    <Sk w={180} h={30} />
                </div>
            </div>
            <SkFormCard fields={3} />
        </main>
    );
}
