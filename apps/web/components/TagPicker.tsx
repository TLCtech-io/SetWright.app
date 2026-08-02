"use client";

import type { Tag } from "@repertoire/core";

// A chip-grid multi-select over the tag vocabulary, keyed and reported by tag NAME
// (the app stores tag associations by name). Shared by the event form and the
// event-type manager. Module-level so it keeps a stable identity across renders.
export function TagPicker({
    vocab,
    selected,
    onToggle,
}: {
    vocab: Tag[];
    selected: Set<string>;
    onToggle: (name: string) => void;
}) {
    return (
        <div className="tag-picker">
            {vocab.map((t) => (
                <label
                    key={t.name}
                    className={`tag-chip${selected.has(t.name) ? " on" : ""}`}
                >
                    <input
                        type="checkbox"
                        checked={selected.has(t.name)}
                        onChange={() => onToggle(t.name)}
                    />
                    {t.name}
                </label>
            ))}
        </div>
    );
}
