import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { TagsManager } from "@/components/TagsManager";

// Reads mutable vocabulary state, so it renders per request.
export const dynamic = "force-dynamic";

export default async function TagsPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const tags = await repo.listTags();
    const usage = await repo.tagUsage();

    return (
        <main className="page vp-page">
            <Link href={`/e/${ensembleId}/settings`} className="back-link">
                &larr; Settings
            </Link>
            <div className="page-head">
                <div>
                    <h1>Tags</h1>
                    <div className="sub">
                        The style vocabulary songs and events draw from
                    </div>
                </div>
            </div>
            <p className="page-intro">
                Tags label a song&apos;s style and steer event context. Renaming
                or recategorizing a tag updates every song and event that
                carries it; deleting one removes it from them. Category drives
                the set&apos;s variety arc &mdash; mood, groove, and genre are
                the &quot;feel&quot; categories.
            </p>
            <TagsManager initial={tags} usage={usage} />
        </main>
    );
}
