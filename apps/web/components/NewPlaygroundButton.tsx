"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Create a program and jump straight into its builder to start arranging.
export function NewPlaygroundButton() {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Synchronous re-entry guard: `disabled` commits a tick late, and Enter (which fires create()
    // directly) can auto-repeat, so a double-fire would POST twice and create two programs. A ref
    // flips immediately, so the second call bails before the fetch.
    const pending = useRef(false);

    const create = async () => {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api${prefix}/playground`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: name.trim() || "New program" }),
            });
            if (!res.ok) {
                setError(`Could not create (${res.status}).`);
                return;
            }
            const { publicId } = await res.json();
            router.push(`${prefix}/playground/${publicId}`);
        } catch {
            setError("Could not reach the server.");
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="pg-new">
            <input
                className="part-label"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New program name"
                aria-label="New program name"
                onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                }}
            />
            <button
                type="button"
                className="perform"
                disabled={busy}
                onClick={create}
            >
                New program
            </button>
            {error && <span className="archive-err">{error}</span>}
        </div>
    );
}
