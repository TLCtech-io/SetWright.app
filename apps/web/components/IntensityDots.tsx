// Five filled-or-empty dots for a 1–5 intensity rating (null = all empty / unrated).
// Shared by the Dashboard set list and the Songs table so the meter reads identically.
export function IntensityDots({ value }: { value: number | null }) {
    const filled =
        value == null ? 0 : Math.min(5, Math.max(0, Math.round(value)));
    return (
        <span
            className="dots"
            aria-label={
                value == null ? "intensity unrated" : `intensity ${filled} of 5`
            }
        >
            {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`dot${n <= filled ? " on" : ""}`} />
            ))}
        </span>
    );
}
