"use client";

// Per-song pin controls. Opener and closer are toggles (one song each); keep is
// shown only when a song was forced in; exclude bars it. Each fires a re-draft.
export function RowControls({
    id,
    isOpener,
    isCloser,
    isKept,
    busy,
    onSetOpen,
    onSetClose,
    onExclude,
    onUnkeep,
}: {
    id: string;
    isOpener: boolean;
    isCloser: boolean;
    isKept: boolean;
    busy: boolean;
    onSetOpen: (id: string) => void;
    onSetClose: (id: string) => void;
    onExclude: (id: string) => void;
    onUnkeep: (id: string) => void;
}) {
    return (
        <div className="row-controls">
            <button
                type="button"
                className={`ctl${isOpener ? " on" : ""}`}
                disabled={busy}
                onClick={() => onSetOpen(id)}
                title="Pin as the opener"
            >
                Opener
            </button>
            <button
                type="button"
                className={`ctl${isCloser ? " on" : ""}`}
                disabled={busy}
                onClick={() => onSetClose(id)}
                title="Pin as the closer"
            >
                Closer
            </button>
            {isKept && (
                <button
                    type="button"
                    className="ctl on"
                    disabled={busy}
                    onClick={() => onUnkeep(id)}
                    title="Stop forcing this song in"
                >
                    Kept
                </button>
            )}
            <button
                type="button"
                className="ctl danger"
                disabled={busy}
                onClick={() => onExclude(id)}
                title="Exclude from the set"
            >
                Exclude
            </button>
        </div>
    );
}
