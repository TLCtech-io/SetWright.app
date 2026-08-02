import type { EquityRow } from "@/lib/equity";

// A bar per member by solo count, most first. A member who has never soloed reads as
// a flagged zero so the gaps are as visible as the hogs. The count's tooltip lists
// the songs.
export function SoloistEquity({
    rows,
    hasPerformed,
}: {
    rows: EquityRow[];
    hasPerformed: boolean;
}) {
    // With no performed sets, every member reads as a zero, which looks like an equity problem rather
    // than no data. Name the upstream action first; only fall to "no members" once sets exist.
    if (!hasPerformed) {
        return (
            <p className="empty">
                No performed sets yet. Mark a set performed and this shows who
                has carried the solos.
            </p>
        );
    }
    if (rows.length === 0) {
        return <p className="empty">No singing members yet.</p>;
    }
    const max = Math.max(1, ...rows.map((r) => r.count));

    return (
        <div className="equity">
            {rows.map((r) => (
                <div
                    key={r.memberId}
                    className={`equity-row${r.count === 0 ? " zero" : ""}`}
                    aria-label={`${r.displayName}${r.departed ? " (former member)" : ""}: ${r.count} solo${r.count === 1 ? "" : "s"}${r.solos.length ? ` (${r.solos.map((s) => s.title).join(", ")})` : ", never soloed"}`}
                >
                    <span className="equity-name">
                        {r.displayName}
                        {r.departed && (
                            <span className="role-tag nonsinging">former</span>
                        )}
                    </span>
                    <div className="equity-track">
                        <div
                            className="equity-bar"
                            style={{ width: `${(r.count / max) * 100}%` }}
                        />
                    </div>
                    <span
                        className="equity-count"
                        title={
                            r.solos.length > 0
                                ? r.solos
                                      .map((s) => `${s.title} (${s.event})`)
                                      .join(", ")
                                : "never soloed"
                        }
                    >
                        {r.count}
                    </span>
                </div>
            ))}
        </div>
    );
}
