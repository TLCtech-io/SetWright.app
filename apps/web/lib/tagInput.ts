// Coerce an untrusted tag payload into a clean TagInput. name is required;
// category is one of the fixed schema enum values, or null (no category).

import type { Tag } from "@repertoire/core";
import type { TagInput } from "./db";

const CATEGORIES: NonNullable<Tag["category"]>[] = [
    "mood",
    "groove",
    "genre",
    "occasion",
    "content",
];

type Result = { ok: true; value: TagInput } | { ok: false; error: string };

export function coerceTagInput(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) return { ok: false, error: "a tag name is required" };
    if (name.length > 40) return { ok: false, error: "tag name is too long" };

    const category = CATEGORIES.includes(
        r.category as NonNullable<Tag["category"]>,
    )
        ? (r.category as Tag["category"])
        : null;

    return { ok: true, value: { name, category } };
}
