// Who is coming to an event, grouped by voice part. Pure projection, no storage or
// transport: the member schedule and the gig call sheet both render its output.
//
// It is deliberately narrow. It takes only the fields a member is allowed to see about their
// peers (a name and their sections) and returns only names, so nothing sensitive (invite email,
// self-confidence, the director's assessment) can leak into a member-facing surface by way of it.
// The caller filters the roster to the active singing pool first; this only shapes what is left.

import type { AvailabilityStatus } from "@repertoire/core";

/** A rostered member, projected to the only fields this grouping reads. */
export interface AttendanceMember {
    id: string;
    displayName: string;
    sections: { voicePartId: string; isPrimary: boolean }[];
}

/** A voice part from the section vocabulary: its label and display order. */
export interface AttendanceVocab {
    id: string;
    label: string;
    sortOrder: number;
}

/** One member's answer for the event (the absence of a row means "not responded"). */
export interface AttendanceAvailability {
    memberId: string;
    status: AvailabilityStatus;
}

/** One section's roll: names split by answer. `pending` is those with no response yet. */
export interface AttendanceGroup {
    sectionId: string | null; // null = the unassigned bucket
    section: string; // the section label, or "Unassigned"
    in: string[];
    tentative: string[];
    out: string[];
    pending: string[];
}

// A member sings one home section (the primary), falling back to their first listed section.
// Members with no section land in the unassigned bucket rather than vanishing.
function homeSection(m: AttendanceMember): string | null {
    if (m.sections.length === 0) return null;
    const home = m.sections.find((s) => s.isPrimary);
    return (home ?? m.sections[0]!).voicePartId;
}

/**
 * Group the roster by home section and split each section by the members' event responses.
 * Sections come out in the vocabulary's sort order, an "Unassigned" bucket (if any) last;
 * empty sections are omitted, and every name list is sorted alphabetically.
 */
export function attendanceGroups(
    availability: AttendanceAvailability[],
    roster: AttendanceMember[],
    voiceParts: AttendanceVocab[],
): AttendanceGroup[] {
    const statusByMember = new Map(
        availability.map((a) => [a.memberId, a.status]),
    );
    const order = [...voiceParts].sort((a, b) => a.sortOrder - b.sortOrder);
    const knownSection = new Map(order.map((v) => [v.id, v.label]));

    // Bucket members by home section id (null = unassigned). A home pointing at a section not in
    // the vocab also falls to unassigned, so a stale link never drops a member from the roll.
    const bySection = new Map<string | null, AttendanceMember[]>();
    for (const m of roster) {
        const home = homeSection(m);
        const key = home != null && knownSection.has(home) ? home : null;
        let list = bySection.get(key);
        if (!list) {
            list = [];
            bySection.set(key, list);
        }
        list.push(m);
    }

    const build = (
        sectionId: string | null,
        members: AttendanceMember[],
    ): AttendanceGroup => {
        const group: AttendanceGroup = {
            sectionId,
            section:
                sectionId != null ? knownSection.get(sectionId)! : "Unassigned",
            in: [],
            tentative: [],
            out: [],
            pending: [],
        };
        for (const m of members) {
            const status = statusByMember.get(m.id);
            if (status === "in") group.in.push(m.displayName);
            else if (status === "tentative")
                group.tentative.push(m.displayName);
            else if (status === "out") group.out.push(m.displayName);
            else group.pending.push(m.displayName);
        }
        const byName = (a: string, b: string) => a.localeCompare(b);
        group.in.sort(byName);
        group.tentative.sort(byName);
        group.out.sort(byName);
        group.pending.sort(byName);
        return group;
    };

    const groups: AttendanceGroup[] = [];
    for (const v of order) {
        const members = bySection.get(v.id);
        if (members && members.length) groups.push(build(v.id, members));
    }
    const unassigned = bySection.get(null);
    if (unassigned && unassigned.length) groups.push(build(null, unassigned));
    return groups;
}
