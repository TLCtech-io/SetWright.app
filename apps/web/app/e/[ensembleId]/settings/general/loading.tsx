import { Sk, SkBackLink, SkFormCard } from "@/components/Skeletons";

// General settings: back-link, a title-only head, and one form card (the ensemble fields).
export default function SettingsGeneralLoading() {
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
