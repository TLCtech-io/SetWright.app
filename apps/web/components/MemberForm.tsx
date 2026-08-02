"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { midi, noteName } from "@repertoire/core";
import type { MemberRole, MemberRow, VoicePartRow } from "@/lib/db";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

const ROLES: MemberRole[] = ["director", "section_leader", "member"];

const validNote = (s: string): boolean => {
    if (!s.trim()) return true; // empty is fine (no range)
    try {
        const n = midi(s.trim());
        return n >= 0 && n <= 127; // must be a real MIDI pitch
    } catch {
        return false;
    }
};

// The director's form to add or edit a member: name, role, vocal range, and an optional invite
// email. Director write.
export function MemberForm({
    mode,
    memberId,
    voicePartOptions,
    initial,
}: {
    mode: "create" | "edit";
    memberId?: string;
    voicePartOptions: VoicePartRow[];
    initial?: MemberRow;
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const m = initial;

    const initialSections = m?.sections ?? [];
    const [name, setName] = useState(m?.displayName ?? "");
    const [role, setRole] = useState<MemberRole>(m?.role ?? "member");
    const [singing, setSinging] = useState(m?.singing ?? true);
    const [parts, setParts] = useState<Set<string>>(
        new Set(initialSections.map((s) => s.voicePartId)),
    );
    const [home, setHome] = useState<string>(
        initialSections.find((s) => s.isPrimary)?.voicePartId ?? "",
    );
    const [low, setLow] = useState(
        m?.rangeLowMidi != null ? noteName(m.rangeLowMidi) : "",
    );
    const [high, setHigh] = useState(
        m?.rangeHighMidi != null ? noteName(m.rangeHighMidi) : "",
    );
    // Add-time invite: optional. On create we fire the existing invite endpoint for the new
    // seat, so the director can add + invite in one step instead of add → edit → invite.
    const [email, setEmail] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Synchronous re-entry guard: `disabled` commits a tick late, so a fast double-submit would
    // create two roster seats. A ref flips immediately, so the second call bails before the fetch.
    const pending = useRef(false);

    const togglePart = (id: string) => {
        setParts((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        // A member can only call home a section they actually cover.
        setHome((h) => (h === id && parts.has(id) ? "" : h));
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!validNote(low) || !validNote(high)) {
            setError("Range notes must be scientific pitch, like G3 or C6.");
            return;
        }
        if (pending.current) return;
        pending.current = true;
        setSaving(true);
        setError(null);
        const body = {
            displayName: name.trim(),
            role,
            singing,
            voicePartIds: [...parts],
            primaryVoicePartId: home || null,
            rangeLow: low.trim(),
            rangeHigh: high.trim(),
        };
        try {
            const url =
                mode === "edit"
                    ? `/api${prefix}/members/${memberId}`
                    : `/api${prefix}/members`;
            const res = await fetch(url, {
                method: mode === "edit" ? "PUT" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setError(
                    `Could not save (${res.status}): ${b.error ?? "unknown"}`,
                );
                setSaving(false);
                pending.current = false;
                return;
            }
            // On add, optionally invite the just-created seat. The seat exists either way; if the
            // invite can't send, drop the director on that member's page so they can resend there.
            if (mode === "create" && email.trim()) {
                const { id: newId, publicId: newPublicId } = (await res
                    .json()
                    .catch(() => ({}))) as { id?: string; publicId?: string };
                if (newId) {
                    const invite = await fetch(
                        `/api${prefix}/members/${newId}/invite`,
                        {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ email: email.trim() }),
                        },
                    );
                    if (!invite.ok) {
                        router.push(`${prefix}/roster/${newPublicId ?? newId}`);
                        router.refresh();
                        return;
                    }
                }
            }
            router.push(`${prefix}/roster`);
            router.refresh();
        } catch {
            setError("Could not reach the server.");
            setSaving(false);
            pending.current = false;
        }
    };

    return (
        <form className="song-form" onSubmit={submit}>
            <section className="form-card">
                <p className="section-label">Singer</p>
                <label className="field">
                    <span>Name</span>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Singer name"
                        autoFocus
                    />
                </label>
                <div className="field-row">
                    <label className="field compact">
                        <span>Role</span>
                        <select
                            value={role}
                            onChange={(e) =>
                                setRole(e.target.value as MemberRole)
                            }
                        >
                            {ROLES.map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field checkbox">
                        <input
                            type="checkbox"
                            checked={singing}
                            onChange={(e) => setSinging(e.target.checked)}
                        />
                        <span>Singing member</span>
                    </label>
                </div>
                <div className="field-row">
                    <label className="field compact">
                        <span>Range low</span>
                        <input
                            value={low}
                            onChange={(e) => setLow(e.target.value)}
                            placeholder="e.g. G3"
                        />
                    </label>
                    <label className="field compact">
                        <span>Range high</span>
                        <input
                            value={high}
                            onChange={(e) => setHigh(e.target.value)}
                            placeholder="e.g. C6"
                        />
                    </label>
                </div>
            </section>

            <section className="form-card">
                <p className="section-label">Voice</p>
                <div className="field">
                    <span>Voice parts</span>
                    <div className="tag-picker">
                        {voicePartOptions.map((vp) => (
                            <label
                                key={vp.id}
                                className={`tag-chip${parts.has(vp.id) ? " on" : ""}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={parts.has(vp.id)}
                                    onChange={() => togglePart(vp.id)}
                                />
                                {vp.label}
                            </label>
                        ))}
                    </div>
                </div>
                <label className="field">
                    <span>Home section</span>
                    <select
                        value={home}
                        onChange={(e) => setHome(e.target.value)}
                        disabled={parts.size === 0}
                    >
                        <option value="">none</option>
                        {voicePartOptions
                            .filter((vp) => parts.has(vp.id))
                            .map((vp) => (
                                <option key={vp.id} value={vp.id}>
                                    {vp.label}
                                </option>
                            ))}
                    </select>
                    <span className="hint">
                        Their main section, used to group the roster.
                    </span>
                </label>
            </section>

            {mode === "create" && (
                <section className="form-card">
                    <p className="section-label">Invite</p>
                    <label className="field">
                        <span>Invite email (optional)</span>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="name@example.com"
                        />
                        <span className="hint">
                            Sends a link to claim a login and self-manage
                            availability. Leave blank to add a roster seat only,
                            you can invite later from their profile.
                        </span>
                    </label>
                </section>
            )}

            {error && <p className="callout shortfall">{error}</p>}

            <div className="form-actions">
                <button type="submit" className="perform" disabled={saving}>
                    {saving
                        ? "Saving…"
                        : mode === "edit"
                          ? "Save changes"
                          : "Add singer"}
                </button>
                <Link href={`${prefix}/roster`} className="ctl">
                    Cancel
                </Link>
            </div>
        </form>
    );
}
