import { formatEventDate } from "@/lib/format";
import type { EquityRow } from "@/lib/equity";

// The member's own feature history: how many solos they have carried across performed sets,
// set against the group average, then the list of them (most recent first). Zero is shown
// plainly, not hidden, so a member who has never been featured still sees where they stand.
// Reuses the soloist-equity reader; this is just the member's own slice of it.
export function MySolos({
    row,
    average,
}: {
    row: EquityRow | null;
    average: number;
}) {
    const count = row?.count ?? 0;
    const avg = average.toFixed(1);
    const solos = [...(row?.solos ?? [])].sort((a, b) =>
        b.date.localeCompare(a.date),
    );

    return (
        <section className="me-solos" aria-labelledby="me-solos-h">
            <div className="me-solos-head">
                <h2 id="me-solos-h">Your solos</h2>
                <span className="me-solos-stat">
                    {count} solo{count === 1 ? "" : "s"} · group avg {avg}
                </span>
            </div>
            {count === 0 ? (
                <p className="me-solos-empty">
                    You haven&rsquo;t been featured on a solo yet. The group
                    averages {avg} per member.
                </p>
            ) : (
                <ul className="me-solos-list">
                    {solos.map((s, i) => (
                        <li
                            key={`${s.title}-${s.date}-${i}`}
                            className="me-solo"
                        >
                            <span className="me-solo-title">{s.title}</span>
                            <span className="me-solo-meta">
                                {[s.event, formatEventDate(s.date) ?? s.date]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
