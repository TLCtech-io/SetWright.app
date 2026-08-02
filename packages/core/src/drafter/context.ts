// Stage 3: context (appropriateness).
//
// Two native policy gates run first, regardless of tags: an explicit chart at an
// event that does not allow it is out, and an accompanied chart at an a-cappella
// event is out. Then hard exclusions by tag (a style a venue bars), then a soft
// preference boost (crowd-pleasers a venue wants). The tag rules are data, passed
// in per event, so nothing here is hard-coded to one group.

import type { ContextPolicy, ResolvedEvent, Song } from "../types.js";

export interface ContextResult {
    eligible: boolean;
    reason?: "explicit" | "accompaniment" | "excluded-tag";
    preferenceBoost: number;
    excludedBy?: string;
}

export function checkContext(
    song: Song,
    event: ResolvedEvent,
    policy?: ContextPolicy,
): ContextResult {
    // Explicit is a policy field, not a tag. Gate it first.
    if (!event.allowsExplicit && song.isExplicit) {
        return { eligible: false, reason: "explicit", preferenceBoost: 0 };
    }

    // Accompaniment is a policy field, not a tag. Gate it native, like explicit: an
    // accompanied chart is out at an a-cappella-only event.
    if (!event.allowsAccompaniment && song.usesAccompaniment) {
        return { eligible: false, reason: "accompaniment", preferenceBoost: 0 };
    }

    if (!policy) return { eligible: true, preferenceBoost: 0 };

    const hardHit = song.tags.find((t) => policy.excludeTags.includes(t.name));
    if (hardHit) {
        return {
            eligible: false,
            reason: "excluded-tag",
            preferenceBoost: 0,
            excludedBy: hardHit.name,
        };
    }

    const boost = song.tags.filter((t) =>
        policy.preferTags.includes(t.name),
    ).length;
    return { eligible: true, preferenceBoost: boost };
}
