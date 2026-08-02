"use client";

import { useEffect, useRef, useState } from "react";

// An inline, per-song annotation. Saves on blur (when changed); the parent persists
// it and updates the shared notes, which syncs back here.
export function SetItemNote({
    songId,
    value,
    busy,
    onSet,
}: {
    songId: string;
    value: string;
    busy: boolean;
    onSet: (songId: string, note: string) => void;
}) {
    const [text, setText] = useState(value);
    const editing = useRef(false);
    // Sync from the prop only while the user is not mid-edit, so a re-draft landing
    // under the cursor cannot wipe unsaved typing. Blur re-syncs from the fresh value.
    useEffect(() => {
        if (!editing.current) setText(value);
    }, [value]);

    return (
        <div className="set-note">
            <textarea
                value={text}
                placeholder="Add a note (staging, transition, key reminder)…"
                disabled={busy}
                rows={1}
                aria-label="Set note"
                onFocus={() => {
                    editing.current = true;
                }}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => {
                    editing.current = false;
                    setText(value);
                    const trimmed = text.trim();
                    if (trimmed !== value.trim()) onSet(songId, trimmed);
                }}
                onKeyDown={(e) => {
                    // Blur saves; calling onSet here too would double-fire the same write.
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                        e.currentTarget.blur();
                }}
            />
        </div>
    );
}
