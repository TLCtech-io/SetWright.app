// The plain-English "why the set is thin" summary. The drafter builds it as
// sentence-lines joined by a space: a lead line, then one lever per sentence
// (see core/diagnostics renderShortfall). Split it back so the levers read as a
// scannable list instead of one block. Null means the target is met: render nothing.
export function ShortfallNote({ shortfall }: { shortfall: string | null }) {
    if (!shortfall) return null;

    const sentences = shortfall
        .split(". ")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.endsWith(".") ? s : `${s}.`));
    const [lead, ...levers] = sentences;

    return (
        <div className="diag-block diag-shortfall">
            <div className="module-head">
                <h2 className="module-title">Why it&rsquo;s thin</h2>
            </div>
            {lead && <p className="shortfall-lead">{lead}</p>}
            {levers.length > 0 && (
                <ul className="shortfall-levers">
                    {levers.map((lever, i) => (
                        <li key={i}>{lever}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}
