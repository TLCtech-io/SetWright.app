// The director's forced songs, resolved once and shared. open, close, and keep
// all bypass the gates, so the funnel and the chase lever must agree on exactly
// which song ids those are, or they drift: the funnel places a song the chase
// then names as still blocked.

import type { DraftOptions, ID } from "../types.js";

export interface ResolvedForced {
    open: ID | undefined;
    close: ID | undefined;
    keepIds: ID[];
    forcedIds: Set<ID>;
}

/**
 * Resolve open / close / keep into the forced song set. open wins when one song
 * is pinned to both ends (close drops), and keep is deduped against itself and
 * against the ends, so each forced song is placed and counted once.
 */
export function resolveForced(
    options: DraftOptions | undefined,
): ResolvedForced {
    const opt = options ?? {};
    const open = opt.open;
    const close = opt.close === open ? undefined : opt.close;
    const keepIds = [
        ...new Set(
            (opt.keep ?? []).filter((id) => id !== open && id !== close),
        ),
    ];
    const forcedIds = new Set<ID>(
        [open, close, ...keepIds].filter((id): id is ID => id !== undefined),
    );
    return { open, close, keepIds, forcedIds };
}
