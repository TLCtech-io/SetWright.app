"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConfidenceVisibility, EnsembleSettings } from "@/lib/db";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// Director-only editor for the ensemble row (name, timezone, confidence visibility).
// The write is RLS-gated to the director; a non-director gets a 403 surfaced here.
export function EnsembleSettingsForm({
    initial,
}: {
    initial: EnsembleSettings;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const [name, setName] = useState(initial.name);
    const [timezone, setTimezone] = useState(initial.timezone);
    const [confidenceVisibility, setVisibility] =
        useState<ConfidenceVisibility>(initial.confidenceVisibility);
    // The optimistic-concurrency token: sent as expectedVersion and advanced from each save's
    // response, so a stale tab loses the race (409) instead of silently clobbering.
    const [version, setVersion] = useState(initial.version ?? "");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
            const res = await fetch(`/api${prefix}/settings`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    name: name.trim(),
                    timezone,
                    confidenceVisibility,
                    expectedVersion: version,
                }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                error?: string;
                version?: string;
            };
            if (res.ok) {
                if (body.version) setVersion(body.version);
                setMsg({ text: "Settings saved.", ok: true });
                router.refresh();
            } else {
                setMsg({
                    text: body.error ?? `Could not save (${res.status}).`,
                    ok: false,
                });
            }
        } catch {
            setMsg({ text: "Could not reach the server.", ok: false });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="song-form" onSubmit={onSubmit}>
            <section className="form-card">
                <p className="section-label">Ensemble</p>
                <label className="field">
                    <span>Ensemble name</span>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                    />
                </label>
                <label className="field">
                    <span>Timezone</span>
                    <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                    >
                        {COMMON_TIMEZONES.map((tz) => (
                            <option key={tz} value={tz}>
                                {tz}
                            </option>
                        ))}
                    </select>
                    <span className="hint">
                        Anchors date math: when a set counts as performed
                        “today”.
                    </span>
                </label>
                <label className="field">
                    <span>Confidence visibility</span>
                    <select
                        value={confidenceVisibility}
                        onChange={(e) =>
                            setVisibility(
                                e.target.value as ConfidenceVisibility,
                            )
                        }
                    >
                        <option value="private">
                            Private: only the director sees members’
                            self-reported confidence
                        </option>
                        <option value="shared">
                            Shared: members can see each other’s self-reported
                            confidence
                        </option>
                    </select>
                </label>
                {msg && (
                    <p
                        className={`status${msg.ok ? "" : " error"}`}
                        role="status"
                    >
                        {msg.text}
                    </p>
                )}
            </section>
            <div className="form-actions">
                <button type="submit" className="perform" disabled={busy}>
                    {busy ? "Saving…" : "Save settings"}
                </button>
            </div>
        </form>
    );
}
