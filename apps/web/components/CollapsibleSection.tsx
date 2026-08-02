"use client";

import { useId, useState, type ReactNode } from "react";

// A titled, collapsible card. The whole event page is a stack of these, all collapsed on
// load, so the director opens only the section they are working. The body stays mounted and
// is hidden with the `hidden` attribute rather than unmounted, so an in-progress edit (an
// unsaved agenda, a half-filled form) is never lost by collapsing and reopening the section.
export function CollapsibleSection({
    label,
    hint,
    action,
    defaultOpen = false,
    children,
}: {
    label: string;
    hint?: ReactNode; // a short at-a-glance summary in the header (e.g. "5 on the agenda")
    action?: ReactNode; // a secondary control beside the toggle (e.g. a link to a fuller view)
    defaultOpen?: boolean;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const panelId = useId();

    return (
        <section className={`section-card${open ? " open" : ""}`}>
            <div className="section-card-head">
                <button
                    type="button"
                    className="section-toggle"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpen((o) => !o)}
                >
                    <span className="section-chevron" aria-hidden>
                        ▸
                    </span>
                    <span className="section-card-label">{label}</span>
                    {hint != null && (
                        <span className="section-hint">{hint}</span>
                    )}
                </button>
                {action && <div className="section-card-action">{action}</div>}
            </div>
            <div className="section-card-body" id={panelId} hidden={!open}>
                {children}
            </div>
        </section>
    );
}
