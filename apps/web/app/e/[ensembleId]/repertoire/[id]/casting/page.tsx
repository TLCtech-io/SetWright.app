import Link from "next/link";
import type { SingerProfile, VoicePartRange } from "@repertoire/core";
import { getRepository } from "@/lib/repository";
import { CastingEditor } from "@/components/CastingEditor";

// Reads mutable casting state (and its concurrency token), so it renders per request.
export const dynamic = "force-dynamic";

export default async function CastingPage({
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
            <main className="page">
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

    // The suggestion panel needs the pool's ranges + section eligibility (from the
    // roster read) and the section nominal ranges (from the vocab), alongside the
    // song's parts and current casting. These are the same RLS-scoped reads the
    // roster and voice-part screens use, so no new access surface, no migration.
    const [parts, roster, voiceParts, casting] = await Promise.all([
        repo.getSongParts(uuid),
        repo.listRoster(),
        repo.listVoiceParts(),
        repo.getSongCasting(uuid),
    ]);

    // The casting pool is the active, singing roster (mirroring listMembers), projected
    // to the minimal shape the matcher needs. Range and eligibility only, no PII.
    const singers: SingerProfile[] = roster
        .filter((m) => m.status === "active" && m.singing)
        .map((m) => ({
            memberId: m.id,
            displayName: m.displayName,
            rangeLow: m.rangeLowMidi,
            rangeHigh: m.rangeHighMidi,
            sections: m.sections.map((s) => s.voicePartId),
            homeSection:
                m.sections.find((s) => s.isPrimary)?.voicePartId ?? null,
        }));

    const vpRanges: VoicePartRange[] = voiceParts.map((v) => ({
        voicePartId: v.id,
        nominalLow: v.nominalLowMidi,
        nominalHigh: v.nominalHighMidi,
        isPitched: v.isPitched,
    }));

    return (
        <main className="page casting-page">
            <Link href={`/e/${ensembleId}/repertoire`} className="back-link">
                &larr; Repertoire
            </Link>
            <div className="page-head">
                <div>
                    <h1>Casting</h1>
                    <div className="sub">{song.title}</div>
                </div>
            </div>
            <CastingEditor
                songId={uuid}
                songToken={id}
                parts={parts}
                singers={singers}
                voiceParts={vpRanges}
                initial={casting}
                version={song.version ?? ""}
            />
        </main>
    );
}
