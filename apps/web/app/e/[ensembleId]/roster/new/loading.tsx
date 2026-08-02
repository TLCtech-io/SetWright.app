import { Sk, SkBackLink, SkFormCard } from "@/components/Skeletons";

// The new-singer form: back-link, a title-only head, the singer card, then the voice card whose tag
// row picks the covered parts.
export default function RosterNewLoading() {
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
            <SkFormCard fields={2} />
            <SkFormCard fields={1} chips={5} />
        </main>
    );
}
