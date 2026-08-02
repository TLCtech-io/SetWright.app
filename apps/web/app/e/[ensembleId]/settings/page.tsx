import Link from "next/link";

// The ensemble's settings live here: the tenant row (name, timezone, confidence
// visibility) plus its editable vocabularies (sections, tags, event-templating presets).
export default async function SettingsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    return (
        <main className="page hub-menu">
            <div className="page-head">
                <div>
                    <h1>Settings</h1>
                    <div className="sub">
                        The ensemble&apos;s configuration and vocabularies
                    </div>
                </div>
            </div>
            <div className="cards">
                <Link
                    href={`/e/${ensembleId}/settings/general`}
                    className="card"
                >
                    <div className="card-title">General</div>
                    <div className="card-sub">
                        Ensemble name, timezone, and whether members see each
                        other&apos;s confidence.
                    </div>
                </Link>
                <Link
                    href={`/e/${ensembleId}/settings/sections`}
                    className="card"
                >
                    <div className="card-title">Sections</div>
                    <div className="card-sub">
                        The voice-part vocabulary: add, rename, reorder, and set
                        ranges.
                    </div>
                </Link>
                <Link href={`/e/${ensembleId}/settings/tags`} className="card">
                    <div className="card-title">Tags</div>
                    <div className="card-sub">
                        The style vocabulary: add, rename, recategorize,
                        reorder, and delete.
                    </div>
                </Link>
                <Link
                    href={`/e/${ensembleId}/settings/event-types`}
                    className="card"
                >
                    <div className="card-title">Event types</div>
                    <div className="card-sub">
                        Reusable event presets: default padding, policy, and
                        standing tag rules.
                    </div>
                </Link>
                <Link
                    href={`/e/${ensembleId}/settings/padding-profiles`}
                    className="card"
                >
                    <div className="card-title">Padding profiles</div>
                    <div className="card-sub">
                        Reusable time-overhead presets event types draw their
                        padding from.
                    </div>
                </Link>
            </div>
        </main>
    );
}
