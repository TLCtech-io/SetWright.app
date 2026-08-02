import type { MemberRole } from "@/lib/db";

// The group directory as a MEMBER sees it: safe fields only. No invite email or invite state
// (director admin/PII), no links to the director's per-member pages, no archive controls.
// The server projects each member to this shape before it ever reaches the client.
export interface RosterEntry {
    id: string;
    displayName: string;
    role: MemberRole;
    singing: boolean;
    sections: { label: string; home: boolean }[]; // resolved labels, home first and starred
    range: string | null; // formatted note range, or null when unset
}
export interface RosterSection {
    section: string; // the voice part label, or "No home section"
    members: RosterEntry[];
}

// Up to two initials from a display name ("Ana Marsh" -> "AM", "Ana" -> "A").
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return parts
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("");
}

export function MemberRoster({ sections }: { sections: RosterSection[] }) {
    if (sections.length === 0) return <p className="empty">No members yet.</p>;
    return (
        <div className="roster-grid">
            {sections.map((g) => (
                <section key={g.section} className="roster-card">
                    <div className="roster-card-head">
                        <span className="section-label">{g.section}</span>
                        <span className="roster-count">
                            {g.members.length}{" "}
                            {g.members.length === 1 ? "member" : "members"}
                        </span>
                    </div>
                    <div className="roster-rows">
                        {g.members.map((m) => (
                            <div key={m.id} className="roster-row">
                                <span
                                    className="roster-avatar"
                                    aria-hidden="true"
                                >
                                    {initials(m.displayName)}
                                </span>
                                <div className="roster-main">
                                    <div className="roster-name">
                                        <span>{m.displayName}</span>
                                        {m.role === "director" && (
                                            <span className="epill on">
                                                Director
                                            </span>
                                        )}
                                        {m.role === "section_leader" && (
                                            <span className="epill good">
                                                Section lead
                                            </span>
                                        )}
                                        {!m.singing && (
                                            <span className="epill neutral">
                                                Non-singing
                                            </span>
                                        )}
                                    </div>
                                    <div className="roster-sections">
                                        {m.sections.length ? (
                                            m.sections.map((s, i) => (
                                                <span key={s.label}>
                                                    <span
                                                        className={
                                                            s.home
                                                                ? "roster-home"
                                                                : undefined
                                                        }
                                                    >
                                                        {s.label}
                                                        {s.home ? " ★" : ""}
                                                    </span>
                                                    {i < m.sections.length - 1
                                                        ? ", "
                                                        : ""}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="roster-nosection">
                                                no voice parts
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <span className="roster-range">
                                    {m.range ?? "—"}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
