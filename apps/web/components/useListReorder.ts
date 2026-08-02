"use client";

import { useRef, useState, type PointerEvent } from "react";

// Drag-to-reorder for a list of ids, driven by Pointer Events so it works with a
// mouse, a touch screen, or a pen. The drag starts from the grip handle on each row;
// the rest of the row stays free to scroll on a touch device. Owns the drag/over
// state and the splice, and hands back the grip + wrapper props. Shared by
// EditableSetList and PlaygroundSetList so the reorder logic lives in one place.
//
// (This replaced HTML5 drag-and-drop, whose dragstart/drop events never fire on
// touch, so on a phone or tablet the up/down buttons were the only way to reorder.)
export function useListReorder(
    ids: string[],
    busy: boolean,
    onReorder: (next: string[]) => void,
) {
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    // Refs mirror the state so the pointer handlers read the live values mid-drag; the
    // state captured in a handler closure would be stale by the time the pointer moves.
    const dragRef = useRef<string | null>(null);
    const overRef = useRef<string | null>(null);

    const reset = () => {
        dragRef.current = null;
        overRef.current = null;
        setDragId(null);
        setOverId(null);
    };

    const setOver = (id: string | null) => {
        overRef.current = id;
        setOverId(id);
    };

    const commit = () => {
        const from = dragRef.current ? ids.indexOf(dragRef.current) : -1;
        const to = overRef.current ? ids.indexOf(overRef.current) : -1;
        reset();
        if (from < 0 || to < 0 || from === to) return;
        const next = ids.slice();
        const [moved] = next.splice(from, 1);
        // Standard move: drop the dragged id at the target's index. Removing `from` has
        // already shifted a downward target up by one, so inserting at `to` lands the id
        // in the target's slot in both directions.
        next.splice(to, 0, moved!);
        onReorder(next);
    };

    // Move `id` one slot in `dir` (-1 earlier, +1 later). Wired to the row's up/down
    // buttons: the keyboard- and screen-reader-accessible path, since the grip drag is
    // a pointer gesture hidden from assistive tech.
    const move = (id: string, dir: -1 | 1) => {
        if (busy) return;
        const i = ids.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= ids.length) return;
        const next = ids.slice();
        [next[i], next[j]] = [next[j]!, next[i]!];
        onReorder(next);
    };

    // Spread onto the grip handle. Pointer capture keeps the move/up events coming to
    // the grip even as the finger travels over other rows; elementFromPoint then reads
    // the row currently under the pointer. The grip carries touch-action:none in CSS so
    // a touch-drag on it reorders instead of scrolling the page.
    const gripProps = (id: string) => ({
        onPointerDown: (e: PointerEvent<HTMLElement>) => {
            if (busy || (e.pointerType === "mouse" && e.button !== 0)) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = id;
            setDragId(id);
            setOver(id);
        },
        onPointerMove: (e: PointerEvent<HTMLElement>) => {
            if (!dragRef.current) return;
            const row = document
                .elementFromPoint(e.clientX, e.clientY)
                ?.closest<HTMLElement>("[data-reorder-id]");
            const over = row?.dataset.reorderId ?? null;
            if (over && over !== overRef.current) setOver(over);
        },
        onPointerUp: () => {
            if (dragRef.current) commit();
        },
        onPointerCancel: reset,
    });

    // Spread onto the row wrapper: the drop-target marker plus the drag/over hint classes.
    const wrapProps = (id: string) => ({
        "data-reorder-id": id,
        className: `song-wrap${dragId === id ? " dragging" : ""}${overId === id ? " dragover" : ""}`,
    });

    return { gripProps, wrapProps, move };
}
