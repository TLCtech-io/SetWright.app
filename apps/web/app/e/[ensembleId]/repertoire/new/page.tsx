import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { SongForm } from "@/components/SongForm";

export const dynamic = "force-dynamic";

export default async function NewSongPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/repertoire`} className="back-link">
                &larr; Repertoire
            </Link>
            <div className="page-head">
                <h1>Add song</h1>
            </div>
            <SongForm
                mode="create"
                vocab={await repo.listTags()}
                voicePartOptions={await repo.listVoiceParts()}
            />
        </main>
    );
}
