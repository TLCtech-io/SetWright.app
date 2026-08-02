import Link from "next/link";
import { noteName } from "@repertoire/core";
import type { MemberRow, VoicePartRow } from "@/lib/db";
import { getRepository } from "@/lib/repository";
import {
    MemberRoster,
    type RosterEntry,
    type RosterSection,
} from "@/components/MemberRoster";

export const dynamic = "force-dynamic";

function rangeLabel(m: MemberRow): string | null {
    if (m.rangeLowMidi == null && m.rangeHighMidi == null) return null;
    const lo = m.rangeLowMidi != null ? noteName(m.rangeLowMidi) : "?";
    const hi = m.rangeHighMidi != null ? noteName(m.rangeHighMidi) : "?";
    return `${lo}–${hi}`;
}

// A member's sections as labels, home first and starred; ids no longer in the vocab are dropped.
function sectionLabels(
    m: MemberRow,
    vpById: Map<string, VoicePartRow>,
): { label: string; home: boolean }[] {
    return m.sections
        .map((s) => ({ vp: vpById.get(s.voicePartId), home: s.isPrimary }))
        .filter(
            (x): x is { vp: VoicePartRow; home: boolean } => x.vp !== undefined,
        )
        .sort((a, b) =>
            a.home === b.home
                ? a.vp.sortOrder - b.vp.sortOrder
                : a.home
                  ? -1
                  : 1,
        )
        .map((x) => ({ label: x.vp.label, home: x.home }));
}

const homeId = (m: MemberRow): string | null =>
    m.sections.find((s) => s.isPrimary)?.voicePartId ?? null;

export default async function MyRosterPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const [roster, voiceParts] = await Promise.all([
        repo.listRoster(),
        repo.listVoiceParts(),
    ]);
    const vpById = new Map(voiceParts.map((v) => [v.id, v]));
    const active = roster.filter((m) => m.status === "active");

    // Project to safe fields BEFORE anything reaches the client: name, role, singing, sections,
    // range. Never invite email or invite state (that stays director-only).
    const toEntry = (m: MemberRow): RosterEntry => ({
        id: m.id,
        displayName: m.displayName,
        role: m.role,
        singing: m.singing,
        sections: sectionLabels(m, vpById),
        range: rangeLabel(m),
    });
    const inSection = (vpId: string) =>
        active
            .filter((m) => homeId(m) === vpId)
            .map(toEntry)
            .sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Grouped by home section in vocabulary order, then a "No home section" bucket.
    const sections: RosterSection[] = voiceParts
        .map((vp) => ({ section: vp.label, members: inSection(vp.id) }))
        .filter((g) => g.members.length > 0);
    const unassigned = active
        .filter((m) => homeId(m) === null)
        .map(toEntry)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (unassigned.length)
        sections.push({ section: "No home section", members: unassigned });

    const singing = active.filter((m) => m.singing).length;

    return (
        <main className="page">
            <Link href={`/e/${ensembleId}/me`} className="back-link">
                &larr; Your space
            </Link>
            <div className="page-head">
                <div>
                    <h1>Roster</h1>
                    <div className="sub">
                        Your group by section. {active.length} member
                        {active.length === 1 ? "" : "s"} &middot; {singing}{" "}
                        singing.
                    </div>
                </div>
            </div>
            <MemberRoster sections={sections} />
        </main>
    );
}
