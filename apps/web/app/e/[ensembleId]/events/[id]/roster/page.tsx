import Link from "next/link";
import type { MemberRow, VoicePartRow } from "@/lib/db";
import { getRepository } from "@/lib/repository";

// Reads mutable db state (the event's live availability), so it renders per request.
export const dynamic = "force-dynamic";

type Avail = "in" | "out" | "tentative" | "none";
const AV_LABEL: Record<Avail, string> = {
    in: "In",
    tentative: "Maybe",
    out: "Out",
    none: "No response",
};
const AV_ORDER: Avail[] = ["in", "tentative", "out", "none"];

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return parts
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("");
}

const homeId = (m: MemberRow): string | null =>
    m.sections.find((s) => s.isPrimary)?.voicePartId ?? null;

function tallyLabel(counts: Record<Avail, number>): string {
    return AV_ORDER.filter((k) => counts[k] > 0)
        .map((k) => `${counts[k]} ${k === "tentative" ? "maybe" : k}`)
        .join(" · ");
}

function AttendeeRow({ member, status }: { member: MemberRow; status: Avail }) {
    return (
        <div className="roster-row">
            <span className="roster-avatar" aria-hidden="true">
                {initials(member.displayName)}
            </span>
            <div className="roster-main">
                <div className="roster-name">
                    {member.displayName}
                    {member.role === "director" && (
                        <span className="epill on">Director</span>
                    )}
                    {member.role === "section_leader" && (
                        <span className="epill good">Section lead</span>
                    )}
                </div>
            </div>
            <span className={`roster-avail ${status}`}>
                <span className={`roster-dot ${status}`} aria-hidden="true" />
                {AV_LABEL[status]}
            </span>
        </div>
    );
}

function SectionCard({
    label,
    members,
    statusOf,
}: {
    label: string;
    members: MemberRow[];
    statusOf: (m: MemberRow) => Avail;
}) {
    const counts: Record<Avail, number> = {
        in: 0,
        tentative: 0,
        out: 0,
        none: 0,
    };
    members.forEach((m) => (counts[statusOf(m)] += 1));
    return (
        <section className="roster-card">
            <div className="roster-card-head">
                <span className="section-label">{label}</span>
                <span className="roster-count">{tallyLabel(counts)}</span>
            </div>
            <div className="roster-rows">
                {members.map((m) => (
                    <AttendeeRow key={m.id} member={m} status={statusOf(m)} />
                ))}
            </div>
        </section>
    );
}

export default async function EventRosterPage({
    params,
}: {
    params: Promise<{ ensembleId: string; id: string }>;
}) {
    const { ensembleId, id } = await params;
    const repo = getRepository();
    // The [id] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("event", id);
    const event = uuid ? await repo.getEvent(uuid) : null;

    if (!uuid || !event) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; Events
                </Link>
                <div className="page-head">
                    <h1>Event not found</h1>
                </div>
            </main>
        );
    }

    const roster = await repo.listRoster();
    const voiceParts = await repo.listVoiceParts();

    // Coverage-relevant pool: active singers. Their availability for THIS event, defaulting
    // to "no response" for anyone the RSVP grid hasn't recorded.
    const singers = roster.filter((m) => m.status === "active" && m.singing);
    const availByMember = new Map(
        event.availability.map((a) => [a.memberId, a.status] as const),
    );
    const statusOf = (m: MemberRow): Avail =>
        (availByMember.get(m.id) ?? "none") as Avail;

    const groups = voiceParts
        .map((vp: VoicePartRow) => ({
            vp,
            members: singers.filter((m) => homeId(m) === vp.id),
        }))
        .filter((g) => g.members.length > 0);
    const unassigned = singers.filter((m) => homeId(m) === null);

    const total: Record<Avail, number> = {
        in: 0,
        tentative: 0,
        out: 0,
        none: 0,
    };
    singers.forEach((m) => (total[statusOf(m)] += 1));

    return (
        <main className="page hub">
            <Link href={`/e/${ensembleId}/events/${id}`} className="back-link">
                &larr; {event.name}
            </Link>
            <div className="page-head">
                <div>
                    <h1>Attendance</h1>
                    <div className="sub">
                        {event.name} &middot; {total.in}/{singers.length} in
                        {total.tentative > 0
                            ? ` · ${total.tentative} maybe`
                            : ""}
                        {total.out > 0 ? ` · ${total.out} out` : ""}
                        {total.none > 0 ? ` · ${total.none} no response` : ""}
                    </div>
                </div>
                <Link
                    href={`/e/${ensembleId}/events/${id}`}
                    className="perform"
                >
                    Edit RSVPs
                </Link>
            </div>

            <div className="roster-grid">
                {groups.map((g) => (
                    <SectionCard
                        key={g.vp.id}
                        label={g.vp.label}
                        members={g.members}
                        statusOf={statusOf}
                    />
                ))}
                {unassigned.length > 0 && (
                    <SectionCard
                        label="No home section"
                        members={unassigned}
                        statusOf={statusOf}
                    />
                )}
            </div>
            {singers.length === 0 && (
                <p className="empty">
                    No active singers to show attendance for yet.
                </p>
            )}
        </main>
    );
}
