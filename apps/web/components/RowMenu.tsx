"use client";

import {
    useState,
    useRef,
    useEffect,
    useCallback,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// A line-level actions popover, portalled to <body> so it escapes any table card's overflow and
// scroll wrapper. It is a labelled group of plain links/buttons (NOT role=menu — the items
// Tab-navigate natively, which the group role matches). Closes on outside-click, Escape, and any
// scroll/resize, returning focus to the trigger whenever focus was inside it. Shared by the
// repertoire table and the settings vocabulary managers, so a row shows one quiet ⋮ instead of a
// spread of text buttons, and Delete sits behind a deliberate click.
export function RowMenu({
    label,
    children,
}: {
    label: string;
    children: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const popRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);

    const toggle = () => {
        if (open) {
            setOpen(false);
            return;
        }
        const r = btnRef.current?.getBoundingClientRect();
        if (!r) return;
        const W = 176;
        const H = 150;
        // Right-align the menu under the trigger, flip up if it would run off the bottom.
        const left = Math.max(
            8,
            Math.min(r.right - W, window.innerWidth - W - 8),
        );
        const top =
            r.bottom + H > window.innerHeight
                ? Math.max(8, r.top - H - 6)
                : r.bottom + 6;
        setPos({ top, left });
        setOpen(true);
    };

    useEffect(() => {
        if (!open) return;
        // Close, and hand focus back to the trigger if it was living inside the popover — so a
        // keyboard/AT user is never stranded on <body> when the menu dismisses out from under them.
        const dismiss = () => {
            if (popRef.current?.contains(document.activeElement))
                btnRef.current?.focus();
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") dismiss();
        };
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (btnRef.current?.contains(t) || popRef.current?.contains(t))
                return;
            dismiss();
        };
        const onScroll = () => dismiss();
        document.addEventListener("keydown", onKey);
        document.addEventListener("mousedown", onDown);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
        // Move focus into the popover for keyboard users (it Tab-navigates as plain links/buttons).
        popRef.current?.querySelector<HTMLElement>(".row-menu-item")?.focus();
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onDown);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onScroll);
        };
    }, [open]);

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="row-menu-trigger"
                aria-haspopup="true"
                aria-expanded={open}
                aria-label={label}
                onClick={toggle}
            >
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <circle cx="9" cy="3.5" r="1.5" />
                    <circle cx="9" cy="9" r="1.5" />
                    <circle cx="9" cy="14.5" r="1.5" />
                </svg>
            </button>
            {open &&
                pos &&
                createPortal(
                    <div
                        ref={popRef}
                        className="row-menu-pop"
                        role="group"
                        aria-label={label}
                        style={{ top: pos.top, left: pos.left }}
                    >
                        {children(close)}
                    </div>,
                    document.body,
                )}
        </>
    );
}
