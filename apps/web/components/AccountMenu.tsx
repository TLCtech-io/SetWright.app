"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MyEnsemble } from "@/lib/ensemble";

const ROLE_LABEL: Record<MyEnsemble["role"], string> = {
    director: "Director",
    section_leader: "Section lead",
    member: "Member",
};

// The account dropdown behind the avatar: identity + role, the ensemble switcher, a link to
// your own profile, and sign out — the whole top-right corner collapsed into one control.
// The switcher, email, and sign-out only appear when actually signed in (supabase mode);
// in mock mode the menu is just identity + profile.
export function AccountMenu({
    initials,
    displayName,
    role,
    email,
    ensembles,
    activeEnsembleId,
    profileHref,
}: {
    initials: string;
    displayName: string;
    role: MyEnsemble["role"];
    email: string | null;
    ensembles: MyEnsemble[];
    activeEnsembleId: string;
    profileHref: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const signedIn = email !== null;

    // Close on outside-click or Escape while open.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node))
                setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    // uuid scopes the switch (the cookie is uuid-based); token is what the URL carries.
    async function switchTo(uuid: string, token: string) {
        setOpen(false);
        if (token === activeEnsembleId) return;
        try {
            const res = await fetch("/api/ensembles/switch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ensembleId: uuid }),
            });
            if (!res.ok) {
                // No longer a member of that ensemble (e.g. removed since the menu rendered). Refresh so the
                // stale row drops from the list instead of navigating into an ensemble that bounces to /ensembles.
                router.refresh();
                return;
            }
        } catch {
            // The switch endpoint only refreshes the active-ensemble cookie; navigation
            // still lands on a membership-checked URL, so proceed either way.
        }
        router.push(`/e/${token}/dashboard`);
        router.refresh();
    }

    return (
        <div className="account" ref={ref}>
            <button
                type="button"
                className="nav-avatar"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Account for ${displayName}`}
                onClick={() => setOpen((o) => !o)}
            >
                {initials}
            </button>
            {open && (
                <div className="account-menu" role="menu">
                    <div className="account-head">
                        <div className="account-name">{displayName}</div>
                        <div className="account-sub">
                            {[email, ROLE_LABEL[role]]
                                .filter(Boolean)
                                .join(" · ")}
                        </div>
                    </div>

                    {signedIn && ensembles.length > 0 && (
                        <div className="account-section">
                            <div className="account-label">Ensembles</div>
                            {ensembles.map((e) => (
                                <button
                                    key={e.id}
                                    type="button"
                                    role="menuitem"
                                    className={`account-item${e.publicId === activeEnsembleId ? " active" : ""}`}
                                    onClick={() => switchTo(e.id, e.publicId)}
                                >
                                    <span>{e.name}</span>
                                    {e.role === "director" && (
                                        <span
                                            className="account-star"
                                            aria-label="you direct this"
                                        >
                                            ★
                                        </span>
                                    )}
                                </button>
                            ))}
                            <Link
                                href="/ensembles"
                                role="menuitem"
                                className="account-item muted"
                                onClick={() => setOpen(false)}
                            >
                                Manage ensembles…
                            </Link>
                        </div>
                    )}

                    <div className="account-section">
                        <Link
                            href={profileHref}
                            role="menuitem"
                            className="account-item"
                            onClick={() => setOpen(false)}
                        >
                            Your profile
                        </Link>
                        {signedIn && (
                            <form action="/auth/signout" method="post">
                                <button
                                    type="submit"
                                    role="menuitem"
                                    className="account-item danger"
                                >
                                    Sign out
                                </button>
                            </form>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
