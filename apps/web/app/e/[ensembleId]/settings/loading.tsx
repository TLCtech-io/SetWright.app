import { SkBackLink, SkPageHead, Sk } from "@/components/Skeletons";

// Vocab manager fallback: back-link, head, two intro lines, then a list of manager rows.
export default function SettingsLoading() {
    return (
        <main
            className="page vp-page skeleton-page"
            role="status"
            aria-label="Loading"
            aria-busy="true"
        >
            <SkBackLink />
            <SkPageHead />
            <Sk w="100%" h={13} style={{ display: "block", maxWidth: 640 }} />
            <Sk w="70%" h={13} style={{ display: "block" }} />
            <div className="vp-manager">
                <div className="vp-list">
                    {[0, 1, 2, 3, 4].map((i) => (
                        <div className="vp-row" key={i}>
                            <div>
                                <Sk w={170} h={16} />
                                <Sk w={220} h={12} style={{ marginTop: 8 }} />
                            </div>
                            <Sk w={150} h={30} r={8} />
                        </div>
                    ))}
                </div>
            </div>
        </main>
    );
}
