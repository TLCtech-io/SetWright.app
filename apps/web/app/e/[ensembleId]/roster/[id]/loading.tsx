import { Sk, SkBackLink, SkFormCard } from "@/components/Skeletons";

// The singer detail edit: back-link, a title-only head, the singer card (name/email/status), then
// the voice card whose tag row picks the covered parts.
export default function RosterDetailLoading() {
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
            <SkFormCard fields={1} chips={5} />
        </main>
    );
}
