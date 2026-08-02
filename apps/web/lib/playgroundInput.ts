// Coerce untrusted playground-program payloads. Create needs a name; patch carries
// the full builder state (name + ordered songIds + opener/closer anchors). songIds
// are filtered to known active songs and deduped; an anchor is kept only if it is
// one of those songs, so the stored program never references a song it does not list.

import { MAX_FORM_ITEMS } from "./limits";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PlaygroundPatch {
    name?: string;
    songIds?: string[];
    open?: string | null;
    close?: string | null;
}

export function coercePlaygroundCreate(raw: unknown): Result<{ name: string }> {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) return { ok: false, error: "name is required" };
    return { ok: true, value: { name } };
}

export function coercePlaygroundPatch(
    raw: unknown,
    validSongIds: Set<string>,
): Result<PlaygroundPatch> {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;
    const patch: PlaygroundPatch = {};

    if ("name" in r) {
        const name = typeof r.name === "string" ? r.name.trim() : "";
        if (!name) return { ok: false, error: "name cannot be empty" };
        patch.name = name;
    }

    let ids: string[] | undefined;
    if ("songIds" in r) {
        if (!Array.isArray(r.songIds))
            return { ok: false, error: "songIds must be an array" };
        if (r.songIds.length > MAX_FORM_ITEMS)
            return { ok: false, error: "too many songs" };
        // REPLACE write, strict: an unknown song id is rejected rather than dropped (a silent drop would
        // delete it from the program). A duplicate is a harmless normalization. Empty clears on purpose.
        const seen = new Set<string>();
        ids = [];
        for (const x of r.songIds) {
            if (typeof x !== "string" || !validSongIds.has(x))
                return { ok: false, error: "unknown song id" };
            if (seen.has(x)) continue;
            seen.add(x);
            ids.push(x);
        }
        patch.songIds = ids;
    }

    // An anchor must be one of the songs in the set. Validate against the patch's own songIds when
    // present (the builder always sends them together), else the active vocabulary. Strict: a non-null
    // value that is not a known song is REJECTED, not silently coerced to null — a silent null would
    // clear the director's pin. Only an explicit null (or absent key) unpins.
    const idSet = ids ? new Set(ids) : null;
    const anchorOrReject = (
        v: unknown,
        which: string,
    ): Result<string | null> => {
        if (v === null || v === undefined) return { ok: true, value: null };
        if (
            typeof v === "string" &&
            (idSet ? idSet.has(v) : validSongIds.has(v))
        )
            return { ok: true, value: v };
        return { ok: false, error: `unknown ${which}` };
    };
    if ("open" in r) {
        const a = anchorOrReject(r.open, "opener");
        if (!a.ok) return a;
        patch.open = a.value;
    }
    if ("close" in r) {
        const a = anchorOrReject(r.close, "closer");
        if (!a.ok) return a;
        patch.close = a.value;
    }

    return { ok: true, value: patch };
}
