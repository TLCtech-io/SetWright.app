"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Availability, AvailabilityStatus } from "@repertoire/core";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

const STATUS: AvailabilityStatus[] = ["in", "tentative", "out"];

export interface RsvpGroup {
    label: string;
    members: { id: string; displayName: string }[];
}

// Per-event RSVP, grouped by home section to match the read-only Event roster view. 'in'
// counts toward the available pool, 'tentative' is the chaseable middle, 'out' is a hard no.
// Saving re-drafts everything downstream. The per-section tally is live off the current
// toggles; the save flattens every group's members regardless of grouping.
export function RsvpEditor({
    eventId,
    groups,
    initial,
    version,
}: {
    eventId: string;
    groups: RsvpGroup[];
    initial: Availability[];
    version: string;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const allMembers = useMemo(
        () => groups.flatMap((g) => g.members),
        [groups],
    );
    // Seed only from real responses. A member with no entry is "no reply" (undefined),
    // the schema's absent-row state — distinct from a hard 'out' and outside the drafter's
    // available pool. Seeding everyone to 'in' and saving it would silently mark unresponded
    // members as attending.
    const [status, setStatus] = useState<
        Record<string, AvailabilityStatus | undefined>
    >(() => {
        const m: Record<string, AvailabilityStatus | undefined> = {};
        for (const a of initial) m[a.memberId] = a.status;
        return m;
    });
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
    // The optimistic-concurrency token, advanced from each successful save so back-to-back
    // edits in one session don't false-conflict against their own prior write.
    const [token, setToken] = useState(version);
    // Re-seed the token whenever the server hands down a fresh event version. Saving the event
    // details on the same page (EventForm) bumps event.updated_at and calls router.refresh(), which
    // re-renders this editor with a new `version` prop; without re-seeding, the RSVP save guards on
    // the stale mount-time token and false-conflicts until a full reload (discarding the toggles).
    // `version` only moves forward, so this never reverts a fresher token a just-saved RSVP advanced to.
    useEffect(() => {
        setToken(version);
    }, [version]);

    // Click a status to set it; click the active status again to clear back to no reply,
    // so a mis-click or a stale RSVP can return to the absent-row state.
    const set = (id: string, s: AvailabilityStatus) => {
        setStatus((prev) => ({
            ...prev,
            [id]: prev[id] === s ? undefined : s,
        }));
        setMsg(null);
    };

    const tally = (group: RsvpGroup): string => {
        const counts: Record<AvailabilityStatus, number> = {
            in: 0,
            tentative: 0,
            out: 0,
        };
        let pending = 0;
        for (const m of group.members) {
            const s = status[m.id];
            if (s) counts[s] += 1;
            else pending += 1;
        }
        const parts = STATUS.filter((k) => counts[k] > 0).map(
            (k) => `${counts[k]} ${k}`,
        );
        if (pending > 0) parts.push(`${pending} pending`);
        return parts.join(" · ");
    };

    const save = async () => {
        setSaving(true);
        setMsg(null);
        // Persist only members who actually responded. Omitting a no-reply member leaves them
        // with no availability row (the schema's "no response"), which the REPLACE write honors.
        const availability: Availability[] = allMembers.flatMap((m) => {
            const s = status[m.id];
            return s ? [{ memberId: m.id, status: s }] : [];
        });
        try {
            const res = await fetch(
                `/api${prefix}/events/${eventId}/availability`,
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        availability,
                        expectedVersion: token,
                    }),
                },
            );
            const body = (await res.json().catch(() => ({}))) as {
                version?: string;
                error?: string;
            };
            if (res.ok) {
                if (typeof body.version === "string") setToken(body.version);
                setMsg({ text: "RSVPs saved.", ok: true });
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
            setSaving(false);
        }
    };

    return (
        <div className="rsvp">
            {groups.map((g) => (
                <div key={g.label} className="rsvp-section">
                    <div className="rsvp-section-head">
                        <span className="section-label">{g.label}</span>
                        <span className="rsvp-tally">{tally(g)}</span>
                    </div>
                    <div className="rsvp-list">
                        {g.members.map((m) => (
                            <div key={m.id} className="rsvp-row">
                                <span className="rsvp-name">
                                    {m.displayName}
                                </span>
                                <div className="rsvp-opts">
                                    {STATUS.map((s) => (
                                        <button
                                            key={s}
                                            type="button"
                                            className={`ctl whatif-toggle ${s}${status[m.id] === s ? " on" : ""}`}
                                            aria-pressed={status[m.id] === s}
                                            onClick={() => set(m.id, s)}
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
            {msg && (
                <p className={`status${msg.ok ? "" : " error"}`}>{msg.text}</p>
            )}
            <div className="form-actions">
                <button
                    type="button"
                    className="perform"
                    disabled={saving}
                    onClick={save}
                >
                    {saving ? "Saving…" : "Save RSVPs"}
                </button>
            </div>
        </div>
    );
}
