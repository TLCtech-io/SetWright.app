// The centered front door for the auth/entry pages (sign in, create ensemble, invite welcome,
// and the link-error page). Vertically centers a single card in the viewport, with the SetWright
// mark above it and an optional footer line below. A shared component (no 'use client') so the
// client welcome form can use it too.
import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

export function AuthShell({
    children,
    footer,
}: {
    children: ReactNode;
    footer?: ReactNode;
}) {
    return (
        <main className="auth-shell">
            <div className="auth-inner">
                <BrandMark />
                {children}
                {footer && <div className="auth-foot">{footer}</div>}
            </div>
        </main>
    );
}
