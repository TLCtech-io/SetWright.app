import { Sk, SkBackLink, SkFormCard } from "@/components/Skeletons";

// The new-song form: back-link, a title-only head, and the three form cards (metadata, musical, parts).
export default function RepertoireNewLoading() {
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
            <SkFormCard fields={2} />
            <SkFormCard fields={2} />
        </main>
    );
}
