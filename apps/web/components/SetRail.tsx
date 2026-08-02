import type { ChaseCandidate } from "@repertoire/core";
import { ShortfallNote } from "./ShortfallNote";
import { ChaseModule } from "./ChaseModule";

// The set's diagnosis rail, folded into one panel. "Why it's thin" (the levers) and "Chase to
// open more" (the fix) were two saturated tint cards stacked beside the set, reading as a second
// column that competed with it. Here they are two labelled sections of one calm surface, so the
// rail reads as a single companion to the set. Renders an empty rail when the target is met and
// no one is worth chasing (each child returns null), keeping the workspace grid stable.
export function SetRail({
    shortfall,
    chase,
}: {
    shortfall: string | null;
    chase: ChaseCandidate[];
}) {
    const hasContent = shortfall != null || chase.length > 0;
    return (
        <aside className="set-rail">
            {hasContent && (
                <div className="set-diagnosis">
                    <ShortfallNote shortfall={shortfall} />
                    <ChaseModule chase={chase} />
                </div>
            )}
        </aside>
    );
}
