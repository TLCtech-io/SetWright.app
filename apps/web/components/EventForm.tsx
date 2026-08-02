"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Tag } from "@repertoire/core";
import type {
    EventKind,
    EventRow,
    EventTypeRow,
    ResolvedEventTypePreset,
} from "@/lib/db";
import { formatSeconds } from "@/lib/format";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { parsePositiveDuration as parseDuration } from "@/lib/durationInput";
import { TagPicker } from "./TagPicker";

const intOr = (v: string, dflt: number): number => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// Create or edit an event (a gig or rehearsal): name, venue, date, target and max duration, event
// type preset, and tags. Kind is fixed at create and ignored on edit. Director write.
export function EventForm({
    mode,
    eventId,
    vocab,
    eventTypes,
    presets,
    initial,
    initialKind,
}: {
    mode: "create" | "edit";
    eventId?: string;
    vocab: Tag[];
    eventTypes: EventTypeRow[];
    presets: Record<string, ResolvedEventTypePreset>;
    initial?: EventRow;
    initialKind?: EventKind; // create only: which kind the "+ New …" entry chose
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const ev = initial;
    // kind is fixed at create (a gig stays a gig): the event's own on edit, else the
    // entry-point choice, else gig. The write ignores it on edit.
    const kind: EventKind = ev?.kind ?? initialKind ?? "gig";

    const [name, setName] = useState(ev?.name ?? "");
    const [venue, setVenue] = useState(ev?.venue ?? "");
    const [status, setStatus] = useState<"planned" | "cancelled">(
        ev?.status ?? "planned",
    );
    const [date, setDate] = useState(ev?.resolved.eventDate ?? "");
    const [target, setTarget] = useState(
        ev?.resolved.targetDurationSeconds != null
            ? formatSeconds(ev.resolved.targetDurationSeconds)
            : "20:00",
    );
    const [maxDur, setMaxDur] = useState(
        ev?.resolved.maxDurationSeconds != null
            ? formatSeconds(ev.resolved.maxDurationSeconds)
            : "",
    );
    const [onBook, setOnBook] = useState(ev?.resolved.allowsOnBook ?? true);
    const [explicit, setExplicit] = useState(
        ev?.resolved.allowsExplicit ?? false,
    );
    const [accompaniment, setAccompaniment] = useState(
        ev?.resolved.allowsAccompaniment ?? true,
    );
    const [perSong, setPerSong] = useState(
        String(ev?.resolved.padding.perSongSeconds ?? 30),
    );
    const [perSet, setPerSet] = useState(
        String(ev?.resolved.padding.perSetSeconds ?? 60),
    );
    const [exclude, setExclude] = useState<Set<string>>(
        new Set(ev?.excludeTags ?? []),
    );
    const [prefer, setPrefer] = useState<Set<string>>(
        new Set(ev?.preferTags ?? []),
    );
    const [require_, setRequire] = useState<Set<string>>(
        new Set(ev?.requireTags ?? []),
    );
    const [eventTypeId, setEventTypeId] = useState(ev?.eventTypeId ?? "");
    // True once the director hand-edits any padding/policy/tag field. While false on a
    // new event, picking a type pre-fills from it; afterwards it's pointer-only (the
    // explicit "Apply defaults" button restamps), so a type change never clobbers edits.
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    // Exclude, prefer, and require are mutually exclusive (exclude wins, then require,
    // matching the server), so a tag sits in at most one picker and the saved state
    // matches the screen.
    const flip = (set: Set<string>, name: string): Set<string> => {
        const next = new Set(set);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    };
    const drop = (set: Set<string>, name: string): Set<string> => {
        if (!set.has(name)) return set;
        const next = new Set(set);
        next.delete(name);
        return next;
    };
    const toggleExclude = (name: string) => {
        setExclude((prev) => flip(prev, name));
        setPrefer((prev) => drop(prev, name));
        setRequire((prev) => drop(prev, name));
        setTouched(true);
    };
    const togglePrefer = (name: string) => {
        setPrefer((prev) => flip(prev, name));
        setExclude((prev) => drop(prev, name));
        setRequire((prev) => drop(prev, name));
        setTouched(true);
    };
    const toggleRequire = (name: string) => {
        setRequire((prev) => flip(prev, name));
        setExclude((prev) => drop(prev, name));
        setPrefer((prev) => drop(prev, name));
        setTouched(true);
    };

    // Stamp a type's resolved defaults onto the form fields — via the Apply button,
    // or automatically on a new untouched event's first type pick.
    const applyPreset = (typeId: string) => {
        const p = presets[typeId];
        if (!p) return;
        setOnBook(p.allowsOnBook);
        setExplicit(p.allowsExplicit);
        setAccompaniment(p.allowsAccompaniment);
        setPerSong(String(p.perSongSeconds));
        setPerSet(String(p.perSetSeconds));
        setExclude(new Set(p.excludeTags));
        setPrefer(new Set(p.preferTags));
        setRequire(new Set(p.requireTags));
        setTouched(false); // the applied defaults become the new baseline
    };
    const onTypeChange = (typeId: string) => {
        setEventTypeId(typeId);
        if (mode === "create" && typeId && !touched) applyPreset(typeId);
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        const targetSeconds = parseDuration(target);
        if (targetSeconds === "invalid") {
            setError(
                "Target must be m:ss (like 20:00) or a number of seconds.",
            );
            return;
        }
        const maxSeconds = parseDuration(maxDur);
        if (maxSeconds === "invalid") {
            setError(
                "Hard cap must be m:ss (like 12:00) or a number of seconds.",
            );
            return;
        }
        if (
            maxSeconds !== null &&
            targetSeconds !== null &&
            maxSeconds < targetSeconds
        ) {
            setError("The hard cap must be at least the target length.");
            return;
        }
        setSaving(true);
        setError(null);
        setSaved(false);
        const body = {
            name: name.trim(),
            venue: venue.trim() || null,
            status,
            kind,
            eventTypeId: eventTypeId || null,
            eventDate: date || null,
            targetDurationSeconds: targetSeconds,
            maxDurationSeconds: maxSeconds,
            allowsOnBook: onBook,
            allowsExplicit: explicit,
            allowsAccompaniment: accompaniment,
            perSongSeconds: intOr(perSong, 0),
            perSetSeconds: intOr(perSet, 0),
            excludeTags: [...exclude],
            preferTags: [...prefer],
            requireTags: [...require_],
        };
        try {
            const url =
                mode === "edit"
                    ? `/api${prefix}/events/${eventId}`
                    : `/api${prefix}/events`;
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
                return;
            }
            if (mode === "create") {
                const b = await res.json();
                router.push(`${prefix}/events/${b.publicId}`);
                router.refresh();
            } else {
                setSaved(true);
                setSaving(false);
                router.refresh();
            }
        } catch {
            setError("Could not reach the server.");
            setSaving(false);
        }
    };

    return (
        <form
            className="song-form"
            onSubmit={submit}
            onChange={() => saved && setSaved(false)}
        >
            <section className="form-card">
                <p className="section-label">Event</p>
                <div className="field-row">
                    <label className="field" style={{ flex: 2 }}>
                        <span>Name</span>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Spring concert"
                            autoFocus
                        />
                    </label>
                    <label className="field">
                        <span>Venue</span>
                        <input
                            value={venue}
                            onChange={(e) => setVenue(e.target.value)}
                            placeholder="optional"
                        />
                    </label>
                </div>

                <div className="field-row">
                    <label className="field">
                        <span>Type</span>
                        <select
                            value={eventTypeId}
                            onChange={(e) => onTypeChange(e.target.value)}
                        >
                            <option value="">Untyped</option>
                            {eventTypes.map((t) => (
                                <option key={t.id} value={t.id}>
                                    {t.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {eventTypeId && presets[eventTypeId] && (
                        <button
                            type="button"
                            className="ctl apply-type"
                            onClick={() => applyPreset(eventTypeId)}
                        >
                            Apply{" "}
                            {eventTypes.find((t) => t.id === eventTypeId)
                                ?.name ?? "type"}{" "}
                            defaults
                        </button>
                    )}
                </div>

                <div className="field-row">
                    <label className="field">
                        <span>Date</span>
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Target length (m:ss)</span>
                        <input
                            value={target}
                            onChange={(e) => setTarget(e.target.value)}
                            placeholder="20:00"
                        />
                    </label>
                    <label className="field">
                        <span>Hard cap (m:ss, optional)</span>
                        <input
                            value={maxDur}
                            onChange={(e) => {
                                setMaxDur(e.target.value);
                                setTouched(true);
                            }}
                            placeholder="none"
                        />
                    </label>
                    <label className="field">
                        <span>Status</span>
                        <select
                            value={status}
                            onChange={(e) =>
                                setStatus(
                                    e.target.value as "planned" | "cancelled",
                                )
                            }
                        >
                            <option value="planned">planned</option>
                            <option value="cancelled">cancelled</option>
                        </select>
                    </label>
                </div>
            </section>

            {/* Policies, padding, and context tags are drafter inputs; a rehearsal is never
          drafted, so they only apply to a gig. */}
            {kind === "gig" && (
                <>
                    <section className="form-card">
                        <p className="section-label">Policies &amp; padding</p>
                        <div className="policy-split">
                            <div className="policy-checks">
                                <label className="field checkbox">
                                    <input
                                        type="checkbox"
                                        checked={onBook}
                                        onChange={(e) => {
                                            setOnBook(e.target.checked);
                                            setTouched(true);
                                        }}
                                    />
                                    <span>Allow on-book charts</span>
                                </label>
                                <label className="field checkbox">
                                    <input
                                        type="checkbox"
                                        checked={explicit}
                                        onChange={(e) => {
                                            setExplicit(e.target.checked);
                                            setTouched(true);
                                        }}
                                    />
                                    <span>Allow explicit</span>
                                </label>
                                <label className="field checkbox">
                                    <input
                                        type="checkbox"
                                        checked={accompaniment}
                                        onChange={(e) => {
                                            setAccompaniment(e.target.checked);
                                            setTouched(true);
                                        }}
                                    />
                                    <span>Allow accompaniment</span>
                                </label>
                            </div>
                            <div className="field-row">
                                <label className="field">
                                    <span>Gap between songs (sec)</span>
                                    <input
                                        type="number"
                                        min={0}
                                        value={perSong}
                                        onChange={(e) => {
                                            setPerSong(e.target.value);
                                            setTouched(true);
                                        }}
                                    />
                                </label>
                                <label className="field">
                                    <span>One-time overhead (sec)</span>
                                    <input
                                        type="number"
                                        min={0}
                                        value={perSet}
                                        onChange={(e) => {
                                            setPerSet(e.target.value);
                                            setTouched(true);
                                        }}
                                    />
                                </label>
                            </div>
                        </div>
                    </section>

                    <section className="form-card">
                        <p className="section-label">Song context</p>
                        <div className="field">
                            <span>Exclude songs tagged (context)</span>
                            <TagPicker
                                vocab={vocab}
                                selected={exclude}
                                onToggle={toggleExclude}
                            />
                        </div>
                        <div className="field">
                            <span>Prefer songs tagged (context)</span>
                            <TagPicker
                                vocab={vocab}
                                selected={prefer}
                                onToggle={togglePrefer}
                            />
                        </div>
                        <div className="field">
                            <span>
                                Require a song tagged (the set must include one)
                            </span>
                            <TagPicker
                                vocab={vocab}
                                selected={require_}
                                onToggle={toggleRequire}
                            />
                        </div>
                    </section>
                </>
            )}

            {error && <p className="callout shortfall">{error}</p>}
            {saved && <p className="status">Saved.</p>}

            <div className="form-actions">
                <button type="submit" className="perform" disabled={saving}>
                    {saving
                        ? "Saving…"
                        : mode === "edit"
                          ? "Save changes"
                          : kind === "rehearsal"
                            ? "Create rehearsal"
                            : "Create event"}
                </button>
                <Link href={`${prefix}/events`} className="ctl">
                    {mode === "edit" ? "Back to events" : "Cancel"}
                </Link>
            </div>
        </form>
    );
}
