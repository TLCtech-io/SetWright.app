// Soloist equity: how the solos have been shared across performed sets. Counted from
// who actually soloed (the performance snapshot), not the current casting. Pure over
// plain data. Members with zero solos are kept, so the gaps are as visible as the
// hogs; and a soloist who has since left the group is kept (flagged departed) so the
// historical record never silently shrinks.

export interface SoloAppearance {
    memberId: string;
    displayName: string;
    songTitle: string;
    eventName: string;
    date: string;
}

export interface EquityRow {
    memberId: string;
    displayName: string;
    count: number;
    departed: boolean; // soloed in the archive but no longer in the active singing pool
    solos: { title: string; event: string; date: string }[];
}

export function soloistEquity(
    appearances: SoloAppearance[],
    roster: { id: string; displayName: string }[],
): EquityRow[] {
    const byMember = new Map<string, SoloAppearance[]>();
    for (const a of appearances) {
        const arr = byMember.get(a.memberId);
        if (arr) arr.push(a);
        else byMember.set(a.memberId, [a]);
    }
    const toSolos = (apps: SoloAppearance[]) =>
        apps.map((a) => ({
            title: a.songTitle,
            event: a.eventName,
            date: a.date,
        }));

    const rows = new Map<string, EquityRow>();
    // The active singing pool first, so a current member with no solos still shows.
    for (const m of roster) {
        const apps = byMember.get(m.id) ?? [];
        rows.set(m.id, {
            memberId: m.id,
            displayName: m.displayName,
            count: apps.length,
            departed: false,
            solos: toSolos(apps),
        });
    }
    // Then anyone who soloed but is no longer in the pool, so history is not lost.
    for (const [memberId, apps] of byMember) {
        if (rows.has(memberId)) continue;
        rows.set(memberId, {
            memberId,
            displayName: apps[0]!.displayName,
            count: apps.length,
            departed: true,
            solos: toSolos(apps),
        });
    }

    return [...rows.values()].sort(
        (a, b) =>
            b.count - a.count || a.displayName.localeCompare(b.displayName),
    );
}
