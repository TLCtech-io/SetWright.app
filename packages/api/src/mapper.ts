// Map the hydration JSON onto core's DraftInput. Near-passthrough: the arrays
// already match by field name, so the only work is folding the three tag lists
// into options.context.

import type { DraftInput } from "@repertoire/core";
import type { HydrationPayload } from "./types.js";

export function toDraftInput(payload: HydrationPayload): DraftInput {
    return {
        songs: payload.songs,
        parts: payload.parts,
        castings: payload.castings,
        availability: payload.availability,
        event: payload.event,
        members: payload.members,
        options: {
            context: {
                excludeTags: payload.excludeTags ?? [],
                preferTags: payload.preferTags ?? [],
                requireTags: payload.requireTags ?? [],
            },
        },
    };
}
