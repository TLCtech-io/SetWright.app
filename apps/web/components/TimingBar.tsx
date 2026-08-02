import { formatSeconds } from "@/lib/format";

// Total padded time against the target. Under reads warm (short is the bias),
// over reads as a problem, at/near target reads good. No target is just a total.
export function TimingBar({
    totalSeconds,
    targetSeconds,
    unknownDurations = false,
}: {
    totalSeconds: number;
    targetSeconds: number | null;
    // True when a song in the set has no duration (e.g. a pinned song with no length entered): the
    // total omits its time, so it is a floor, not exact. Render a "+" and say so rather than pass off
    // the precise-looking number as complete.
    unknownDurations?: boolean;
}) {
    const totalText = `${formatSeconds(totalSeconds)}${unknownDurations ? "+" : ""}`;
    if (targetSeconds === null) {
        // No target: nothing to budget against, so one quiet line, not the full band.
        return (
            <p className="timing-none">
                {totalText} total
                <span className="muted">
                    {" · "}
                    {unknownDurations
                        ? "a pinned song has no length set"
                        : "no target set"}
                </span>
            </p>
        );
    }

    const ratio = targetSeconds > 0 ? totalSeconds / targetSeconds : 0;
    const pct = Math.min(100, Math.round(ratio * 100));
    const state = ratio > 1.0 ? "over" : ratio >= 0.95 ? "met" : "under";
    const delta = totalSeconds - targetSeconds;
    const deltaLabel =
        state === "met"
            ? "on target"
            : delta < 0
              ? `${formatSeconds(-delta)} under`
              : `${formatSeconds(delta)} over`;

    return (
        <div className="timing">
            <div className="timing-row">
                <span>
                    {totalText} of {formatSeconds(targetSeconds)}
                </span>
                <span className="muted">
                    {unknownDurations
                        ? "a pinned song has no length set"
                        : deltaLabel}
                </span>
            </div>
            <div className="timing-track">
                <div
                    className={`timing-fill ${state}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}
