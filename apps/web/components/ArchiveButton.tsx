"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

type Resource = "songs" | "members";

// Songs archive, members go inactive (the schema's two lifecycle values). The
// button toggles a record between active and its resource's off-state, then
// refreshes the server-rendered list. Surfaces failure rather than faking success.
const OFF: Record<Resource, string> = {
    songs: "archived",
    members: "inactive",
};
const LABEL: Record<Resource, { off: string; on: string }> = {
    songs: { off: "Archive", on: "Restore" },
    members: { off: "Deactivate", on: "Reactivate" },
};

export function ArchiveButton({
    id,
    active,
    resource,
    variant = "button",
    onActed,
}: {
    id: string;
    active: boolean;
    resource: Resource;
    // 'menuitem' renders as a row-menu entry (the Songs actions menu); default is the
    // standalone .ctl button. onActed fires after a successful toggle (e.g. to close a menu).
    variant?: "button" | "menuitem";
    onActed?: () => void;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const target = active ? OFF[resource] : "active";
    const menuitem = variant === "menuitem";

    const onClick = async () => {
        setBusy(true);
        setFailed(false);
        try {
            const res = await fetch(`/api${prefix}/${resource}/${id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: target }),
            });
            if (!res.ok) {
                setFailed(true);
                return;
            }
            onActed?.();
            router.refresh();
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className={menuitem ? "row-menu-item-wrap" : "archive-action"}>
            <button
                type="button"
                className={menuitem ? "row-menu-item" : "ctl"}
                disabled={busy}
                onClick={onClick}
            >
                {active ? LABEL[resource].off : LABEL[resource].on}
            </button>
            {failed && (
                <span className="archive-err" role="alert">
                    The change didn’t save. Try again.
                </span>
            )}
        </span>
    );
}
