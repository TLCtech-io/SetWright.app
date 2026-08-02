import Link from "next/link";
import { noteName } from "@repertoire/core";
import type { MemberRow, VoicePartRow } from "@/lib/db";
import { getRepository } from "@/lib/repository";
import { ArchiveButton } from "@/components/ArchiveButton";

// Reads mutable db state, so it must render per request rather than prerender
// static (which would never reflect added/edited/archived singers).
export const dynamic = "force-dynamic";

function rangeLabel(m: MemberRow): string {
    if (m.rangeLowMidi == null && m.rangeHighMidi == null) return "no range";
    const lo = m.rangeLowMidi != null ? noteName(m.rangeLowMidi) : "?";
    const hi = m.rangeHighMidi != null ? noteName(m.rangeHighMidi) : "?";
    return `${lo}–${hi}`;
}

// Up to two initials from a display name ("Ana Marsh" → "AM", "Ana" → "A").
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return parts
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("");
}

// A member's sections as labels, home section first and starred. Resolves ids
// through the vocabulary and drops any that no longer exist.
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

function SingerRow({
    member,
    vpById,
    ensembleId,
}: {
    member: MemberRow;
    vpById: Map<string, VoicePartRow>;
    ensembleId: string;
}) {
    const sections = sectionLabels(member, vpById);
    return (
        <div
            className={`roster-row${member.status === "inactive" ? " inactive" : ""}`}
        >
            <span className="roster-avatar" aria-hidden="true">
                {initials(member.displayName)}
            </span>
            <div className="roster-main">
                <div className="roster-name">
                    <Link href={`/e/${ensembleId}/roster/${member.publicId}`}>
                        {member.displayName}
                    </Link>
                    {member.role === "director" && (
                        <span className="epill on">Director</span>
                    )}
                    {member.role === "section_leader" && (
                        <span className="epill good">Section lead</span>
                    )}
                    {!member.singing && (
                        <span className="epill neutral">Non-singing</span>
                    )}
                    {!member.claimed && member.inviteEmail && (
                        <span className="epill warn">Invite pending</span>
                    )}
                </div>
                <div className="roster-sections">
                    {sections.length ? (
                        sections.map((s, i) => (
                            <span key={s.label}>
                                <span
                                    className={
                                        s.home ? "roster-home" : undefined
                                    }
                                >
                                    {s.label}
                                    {s.home ? " ★" : ""}
                                </span>
                                {i < sections.length - 1 ? ", " : ""}
                            </span>
                        ))
                    ) : (
                        <span className="roster-nosection">no voice parts</span>
                    )}
                </div>
            </div>
            <span className="roster-range">{rangeLabel(member)}</span>
            <div className="roster-actions">
                <ArchiveButton
                    id={member.id}
                    active={member.status === "active"}
                    resource="members"
                />
            </div>
        </div>
    );
}

const homeId = (m: MemberRow): string | null =>
    m.sections.find((s) => s.isPrimary)?.voicePartId ?? null;

function RosterCard({
    label,
    members,
    vpById,
    ensembleId,
}: {
    label: string;
    members: MemberRow[];
    vpById: Map<string, VoicePartRow>;
    ensembleId: string;
}) {
    return (
        <section className="roster-card">
            <div className="roster-card-head">
                <span className="section-label">{label}</span>
                <span className="roster-count">
                    {members.length}{" "}
                    {members.length === 1 ? "singer" : "singers"}
                </span>
            </div>
            <div className="roster-rows">
                {members.map((m) => (
                    <SingerRow
                        key={m.id}
                        member={m}
                        vpById={vpById}
                        ensembleId={ensembleId}
                    />
                ))}
            </div>
        </section>
    );
}

export default async function RosterPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const repo = getRepository();
    const roster = await repo.listRoster();
    const voiceParts = await repo.listVoiceParts(); // sorted by sortOrder
    const vpById = new Map(voiceParts.map((v) => [v.id, v]));
    const active = roster.filter((m) => m.status === "active");
    const singing = active.filter((m) => m.singing).length;
    const inactive = roster.filter((m) => m.status === "inactive");

    // Active members grouped by home section in vocabulary order, then those with
    // no home, then the inactive list.
    const groups = voiceParts
        .map((vp) => ({
            vp,
            members: active.filter((m) => homeId(m) === vp.id),
        }))
        .filter((g) => g.members.length > 0);
    const unassigned = active.filter((m) => homeId(m) === null);

    return (
        <main className="page hub">
            <div className="page-head">
                <div>
                    <h1>Roster</h1>
                    <div className="sub">
                        {active.length} active member
                        {active.length === 1 ? "" : "s"} &middot; {singing}{" "}
                        singing
                    </div>
                </div>
                <div className="head-actions">
                    <Link
                        href={`/e/${ensembleId}/settings/sections`}
                        className="ctl"
                    >
                        Sections
                    </Link>
                    <Link
                        href={`/e/${ensembleId}/roster/new`}
                        className="perform"
                    >
                        Add singer
                    </Link>
                </div>
            </div>

            <div className="roster-grid">
                {active.length <= 1 && (
                    <section className="roster-add-tile">
                        <span className="section-label">Your singers</span>
                        <p>
                            It&rsquo;s just you so far. Add your singers, or
                            invite them to fill in their own range and sections.
                        </p>
                        <Link
                            href={`/e/${ensembleId}/roster/new`}
                            className="empty-cta"
                        >
                            Add singer &rarr;
                        </Link>
                    </section>
                )}

                {groups.map((g) => (
                    <RosterCard
                        key={g.vp.id}
                        label={g.vp.label}
                        members={g.members}
                        vpById={vpById}
                        ensembleId={ensembleId}
                    />
                ))}

                {unassigned.length > 0 && (
                    <RosterCard
                        label="No home section"
                        members={unassigned}
                        vpById={vpById}
                        ensembleId={ensembleId}
                    />
                )}

                {inactive.length > 0 && (
                    <RosterCard
                        label="Inactive"
                        members={inactive}
                        vpById={vpById}
                        ensembleId={ensembleId}
                    />
                )}
            </div>
        </main>
    );
}
