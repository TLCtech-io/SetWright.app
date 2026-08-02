// Shared coercion for the three context-tag rule lists (exclude / require / prefer). The event and
// event-type forms post the same shape and enforce the same precedence, so the logic lives here.
// Names are resolved against the vocabulary, deduped, and capped; then precedence exclude > require >
// prefer makes the three lists disjoint (a tag in more than one keeps the strongest effect).

import { MAX_FORM_ITEMS } from "./limits";

export interface TagRules {
    excludeTags: string[];
    preferTags: string[];
    requireTags: string[];
}

const tagList = (v: unknown, vocab: Set<string>): string[] =>
    Array.isArray(v)
        ? [
              ...new Set(
                  v
                      .slice(0, MAX_FORM_ITEMS)
                      .filter(
                          (x): x is string =>
                              typeof x === "string" && vocab.has(x),
                      ),
              ),
          ]
        : [];

export function coerceTagRules(
    raw: Record<string, unknown>,
    vocab: Set<string>,
): TagRules {
    const excludeTags = tagList(raw.excludeTags, vocab);
    const requireTags = tagList(raw.requireTags, vocab).filter(
        (t) => !excludeTags.includes(t),
    );
    const preferTags = tagList(raw.preferTags, vocab).filter(
        (t) => !excludeTags.includes(t) && !requireTags.includes(t),
    );
    return { excludeTags, preferTags, requireTags };
}
