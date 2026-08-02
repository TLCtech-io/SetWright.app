// Coerce an untrusted event-type payload into a clean EventTypeInput. name required;
// paddingProfileId passes through as a string or null (existence is validated mock-side,
// matching the schema's SET NULL tolerance); policy booleans default like the event
// coercer (on-book true, explicit false); tag rules are names filtered to the
// vocabulary, with exclude winning over prefer.

import type { EventTypeInput } from "./db";
import { coerceTagRules } from "./tagRulesInput";
import { UUID_RE } from "./repository";

type Result =
    | { ok: true; value: EventTypeInput }
    | { ok: false; error: string };

export function coerceEventTypeInput(raw: unknown, vocab: Set<string>): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) return { ok: false, error: "an event-type name is required" };
    if (name.length > 40)
        return { ok: false, error: "event-type name is too long" };

    // Honor the reference only if it is a well-formed uuid; a non-uuid string would reach the
    // padding_profile lookup as a bad cast (22P02) and 500. A malformed id drops to null (no
    // profile), matching the "honor only if it resolves" tolerance and the schema's SET NULL.
    const paddingProfileId =
        typeof r.paddingProfileId === "string" &&
        UUID_RE.test(r.paddingProfileId)
            ? r.paddingProfileId
            : null;
    const defaultAllowsOnBook = r.defaultAllowsOnBook !== false; // default true
    const defaultAllowsExplicit = r.defaultAllowsExplicit === true; // default false
    const defaultAllowsAccompaniment = r.defaultAllowsAccompaniment !== false; // default true
    // Precedence exclude > require > prefer, deduped and capped against the vocabulary (shared).
    // Note: this now caps the lists to MAX_FORM_ITEMS, which the event-type coercer did not before.
    const { excludeTags, preferTags, requireTags } = coerceTagRules(r, vocab);

    return {
        ok: true,
        value: {
            name,
            paddingProfileId,
            defaultAllowsOnBook,
            defaultAllowsExplicit,
            defaultAllowsAccompaniment,
            excludeTags,
            preferTags,
            requireTags,
        },
    };
}
