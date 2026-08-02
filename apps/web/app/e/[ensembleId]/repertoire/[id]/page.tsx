import Link from "next/link";
import { getRepository } from "@/lib/repository";
import { SongForm } from "@/components/SongForm";

// Reads mutable song state (and its concurrency token), so it renders per request.
export const dynamic = "force-dynamic";

export default async function EditSongPage({
    params,
}: {
    params: Promise<{ ensembleId: string; id: string }>;
}) {
    const repo = getRepository();
    const { ensembleId, id } = await params;
    // The [id] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("song", id);
    const song = uuid ? await repo.getSong(uuid) : null;

    if (!uuid || !song) {
        return (
            <main className="page form-page">
                <Link
                    href={`/e/${ensembleId}/repertoire`}
                    className="back-link"
                >
                    &larr; Repertoire
                </Link>
                <div className="page-head">
                    <h1>Song not found</h1>
                </div>
            </main>
        );
    }

    return (
        <main className="page form-page">
            <Link href={`/e/${ensembleId}/repertoire`} className="back-link">
                &larr; Repertoire
            </Link>
            <div className="page-head narrow">
                <h1>Edit song</h1>
                <Link
                    href={`/e/${ensembleId}/repertoire/${id}/casting`}
                    className="ctl regen"
                >
                    Cast this song
                </Link>
            </div>
            <SongForm
                mode="edit"
                songId={uuid}
                vocab={await repo.listTags()}
                voicePartOptions={await repo.listVoiceParts()}
                initial={{ song, parts: await repo.getSongParts(uuid) }}
            />
        </main>
    );
}
