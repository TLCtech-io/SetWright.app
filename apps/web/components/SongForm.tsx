"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { keyLabel, midi, noteName } from "@repertoire/core";
import type {
    AssessedReadiness,
    BookStatus,
    KeySig,
    Tag,
} from "@repertoire/core";
import type { MockPart, SongRow, VoicePartRow } from "@/lib/db";
import { formatSeconds } from "@/lib/format";
import { pitchClassOrNull } from "@/lib/pitchClass";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";
import { parsePositiveDuration as parseDuration } from "@/lib/durationInput";

// Key options for both modes, labelled the way a musician reads them. The range
// -7..7 covers every standard key signature, 7 flats to 7 sharps. The enharmonic
// pairs (Cb/B, Gb/F#, Db/C#, and the minor ones) each get both spellings on
// purpose, so a chart written in Gb and one written in F# each find their own
// entry and the director picks the one the score uses. Empty means "no key".
const KEY_OPTIONS: { value: string; label: string }[] = [];
for (const mode of ["major", "minor"] as const) {
    for (let f = -7; f <= 7; f++) {
        KEY_OPTIONS.push({
            value: `${f}:${mode}`,
            label: keyLabel({ fifths: f, mode }),
        });
    }
}

const keyValue = (k: KeySig | null): string =>
    k ? `${k.fifths}:${k.mode}` : "";
const parseKey = (v: string): KeySig | null => {
    if (!v) return null;
    const [f, mode] = v.split(":");
    return { fifths: Number(f), mode: mode === "minor" ? "minor" : "major" };
};
const parseIntOrNull = (v: string): number | null => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};
const validNote = (s: string): boolean => {
    if (!s.trim()) return true;
    try {
        const n = midi(s.trim());
        return n >= 0 && n <= 127;
    } catch {
        return false;
    }
};
// The starting pitch (a pitch class): empty (use the key tonic) or a value the shared
// parser accepts, so the client guard and the server coercer never disagree.
const validPitchClass = (s: string): boolean =>
    !s.trim() || pitchClassOrNull(s) !== null;

const READINESS: AssessedReadiness[] = [
    "performance-ready",
    "needs-polish",
    "learning",
    "dormant",
];
const BOOK: BookStatus[] = ["off-book", "on-book"];

interface PartDraft {
    id?: string;
    label: string;
    isRequired: boolean;
    count: string; // held as text so it can be cleared mid-edit; coerced on submit
    isSolo: boolean;
    voicePartId: string; // '' = no/unspecified section
    rangeLow: string; // note name
    rangeHigh: string;
}

export function SongForm({
    mode,
    songId,
    vocab,
    voicePartOptions,
    initial,
}: {
    mode: "create" | "edit";
    songId?: string;
    vocab: Tag[];
    voicePartOptions: VoicePartRow[];
    initial?: { song: SongRow; parts: MockPart[] };
}) {
    const router = useRouter();
    const prefix = useEnsemblePrefix();
    const s = initial?.song;

    const [title, setTitle] = useState(s?.title ?? "");
    const [arranger, setArranger] = useState(s?.arranger ?? "");
    const [chartRef, setChartRef] = useState(s?.chartRef ?? "");
    const [lastRehearsed, setLastRehearsed] = useState(s?.lastRehearsed ?? "");
    const [startPitch, setStartPitch] = useState(s?.startPitch ?? "");
    const [startKey, setStartKey] = useState(keyValue(s?.startKey ?? null));
    const [endKey, setEndKey] = useState(keyValue(s?.endKey ?? null));
    const [startTempo, setStartTempo] = useState(
        s?.startTempoBpm != null ? String(s.startTempoBpm) : "",
    );
    const [endTempo, setEndTempo] = useState(
        s?.endTempoBpm != null ? String(s.endTempoBpm) : "",
    );
    const [duration, setDuration] = useState(
        s?.durationSeconds != null ? formatSeconds(s.durationSeconds) : "",
    );
    const [intensity, setIntensity] = useState(
        s?.intensity != null ? String(s.intensity) : "",
    );
    const [tagNames, setTagNames] = useState<Set<string>>(
        new Set(s?.tags.map((t) => t.name) ?? []),
    );
    const [readiness, setReadiness] = useState<AssessedReadiness>(
        s?.assessedReadiness ?? "performance-ready",
    );
    const [bookStatus, setBookStatus] = useState<BookStatus>(
        s?.bookStatus ?? "off-book",
    );
    const [explicit, setExplicit] = useState(s?.isExplicit ?? false);
    const [accompaniment, setAccompaniment] = useState(
        s?.usesAccompaniment ?? false,
    );
    const [parts, setParts] = useState<PartDraft[]>(
        initial?.parts.map((p) => ({
            id: p.id,
            label: p.label,
            isRequired: p.isRequired,
            count: String(p.countNeeded),
            isSolo: p.isSolo,
            voicePartId: p.voicePartId ?? "",
            rangeLow: p.rangeLowMidi != null ? noteName(p.rangeLowMidi) : "",
            rangeHigh: p.rangeHighMidi != null ? noteName(p.rangeHighMidi) : "",
        })) ?? [
            {
                label: "Lead",
                isRequired: true,
                count: "1",
                isSolo: true,
                voicePartId: "",
                rangeLow: "",
                rangeHigh: "",
            },
        ],
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggleTag = (name: string) =>
        setTagNames((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });

    const setPart = (i: number, patch: Partial<PartDraft>) =>
        setParts((prev) =>
            prev.map((p, j) => (j === i ? { ...p, ...patch } : p)),
        );
    const addPart = () =>
        setParts((prev) => [
            ...prev,
            {
                label: "",
                isRequired: true,
                count: "1",
                isSolo: false,
                voicePartId: "",
                rangeLow: "",
                rangeHigh: "",
            },
        ]);
    const removePart = (i: number) =>
        setParts((prev) => prev.filter((_, j) => j !== i));
    // Reorder a part row. Order is persisted from the array index on save (no separate
    // reorder call), so this is a local swap; the boundary buttons are disabled at the ends.
    const movePart = (i: number, dir: -1 | 1) =>
        setParts((prev) => {
            const j = i + dir;
            if (j < 0 || j >= prev.length) return prev;
            const next = prev.slice();
            [next[i], next[j]] = [next[j]!, next[i]!];
            return next;
        });

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!title.trim()) {
            setError("A title is required.");
            return;
        }
        const durationSeconds = parseDuration(duration);
        if (durationSeconds === "invalid") {
            setError(
                "Duration must be m:ss (like 4:00) or a number of seconds.",
            );
            return;
        }
        if (
            parts.some((p) => !validNote(p.rangeLow) || !validNote(p.rangeHigh))
        ) {
            setError(
                "Part range notes must be scientific pitch, like C4 or A5.",
            );
            return;
        }
        if (!validPitchClass(startPitch)) {
            setError(
                "Starting pitch must be a pitch class like C#, Eb, or A (no octave).",
            );
            return;
        }
        if (parts.some((p) => p.label.trim() && !p.isSolo && !p.voicePartId)) {
            setError("Each non-solo part needs a section (or mark it a solo).");
            return;
        }
        setSaving(true);
        setError(null);
        const body = {
            // Edit mode is an optimistic-concurrency write: send the version loaded with the
            // song so a stale save is rejected (409). Create mode has no token and ignores it.
            expectedVersion: initial?.song.version,
            title: title.trim(),
            arranger: arranger.trim() || null,
            chartRef: chartRef.trim() || null,
            lastRehearsed: lastRehearsed || null,
            startPitch: startPitch.trim(),
            startKey: parseKey(startKey),
            endKey: parseKey(endKey),
            startTempoBpm: parseIntOrNull(startTempo),
            endTempoBpm: parseIntOrNull(endTempo),
            durationSeconds,
            isExplicit: explicit,
            usesAccompaniment: accompaniment,
            intensity: intensity === "" ? null : Number(intensity),
            tags: [...tagNames],
            assessedReadiness: readiness,
            bookStatus,
            parts: parts
                .filter((p) => p.label.trim())
                .map((p) => ({
                    id: p.id,
                    label: p.label.trim(),
                    isRequired: p.isRequired,
                    countNeeded: Math.max(1, parseInt(p.count, 10) || 1),
                    isSolo: p.isSolo,
                    voicePartId: p.isSolo ? null : p.voicePartId || null,
                    rangeLow: p.rangeLow.trim(),
                    rangeHigh: p.rangeHigh.trim(),
                })),
        };
        try {
            const url =
                mode === "edit"
                    ? `/api${prefix}/songs/${songId}`
                    : `/api${prefix}/songs`;
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
            router.push(`${prefix}/repertoire`);
            router.refresh();
        } catch {
            setError("Could not reach the server.");
            setSaving(false);
        }
    };

    const hasNewRequiredPart = parts.some(
        (p) => !p.id && p.isRequired && p.label.trim(),
    );

    return (
        <form className="song-form" onSubmit={submit}>
            <section className="form-card">
                <p className="section-label">Song</p>
                <div className="field-row">
                    <label className="field" style={{ flex: 2 }}>
                        <span>Title</span>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Song title"
                            autoFocus
                        />
                    </label>
                    <label className="field">
                        <span>Arranger</span>
                        <input
                            value={arranger}
                            onChange={(e) => setArranger(e.target.value)}
                            placeholder="optional"
                        />
                    </label>
                </div>
                <div className="field-row">
                    <label className="field" style={{ flex: 2 }}>
                        <span>Chart link / location</span>
                        <input
                            value={chartRef}
                            onChange={(e) => setChartRef(e.target.value)}
                            placeholder="URL or where the music lives"
                        />
                    </label>
                    <label className="field">
                        <span>Last rehearsed</span>
                        <input
                            type="date"
                            value={lastRehearsed}
                            onChange={(e) => setLastRehearsed(e.target.value)}
                        />
                    </label>
                </div>
            </section>

            <section className="form-card">
                <p className="section-label">Music</p>
                <div className="field-row">
                    <label className="field">
                        <span>Start key</span>
                        <select
                            value={startKey}
                            onChange={(e) => {
                                const v = e.target.value;
                                setStartKey(v);
                                if (!v) setEndKey(""); // an end key is meaningless without a start (schema CHECK)
                            }}
                        >
                            <option value="">none</option>
                            {KEY_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>End key (if it modulates)</span>
                        <select
                            value={endKey}
                            onChange={(e) => setEndKey(e.target.value)}
                            disabled={!startKey}
                        >
                            <option value="">none</option>
                            {KEY_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Starting pitch</span>
                        <input
                            value={startPitch}
                            onChange={(e) => setStartPitch(e.target.value)}
                            placeholder="key tonic"
                            title="The starting pitch, like C# or Eb (no octave). Leave blank to use the start key's tonic."
                        />
                    </label>
                </div>
                <div className="field-row">
                    <label className="field">
                        <span>Start tempo (bpm)</span>
                        <input
                            type="number"
                            min={1}
                            value={startTempo}
                            onChange={(e) => {
                                const v = e.target.value;
                                setStartTempo(v);
                                if (!v.trim()) setEndTempo(""); // an end tempo is meaningless without a start (schema CHECK)
                            }}
                            placeholder="free"
                        />
                    </label>
                    <label className="field">
                        <span>End tempo (if it changes)</span>
                        <input
                            type="number"
                            min={1}
                            value={endTempo}
                            onChange={(e) => setEndTempo(e.target.value)}
                            placeholder="constant"
                            disabled={!startTempo.trim()}
                        />
                    </label>
                    <label className="field">
                        <span>Duration (m:ss)</span>
                        <input
                            value={duration}
                            onChange={(e) => setDuration(e.target.value)}
                            placeholder="4:00"
                        />
                    </label>
                </div>
            </section>

            <section className="form-card">
                <p className="section-label">Status &amp; tags</p>
                <div className="field-row">
                    <label className="field">
                        <span>Intensity</span>
                        <select
                            value={intensity}
                            onChange={(e) => setIntensity(e.target.value)}
                        >
                            <option value="">unrated</option>
                            {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Readiness</span>
                        <select
                            value={readiness}
                            onChange={(e) =>
                                setReadiness(
                                    e.target.value as AssessedReadiness,
                                )
                            }
                        >
                            {READINESS.map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Book</span>
                        <select
                            value={bookStatus}
                            onChange={(e) =>
                                setBookStatus(e.target.value as BookStatus)
                            }
                        >
                            {BOOK.map((b) => (
                                <option key={b} value={b}>
                                    {b}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field checkbox">
                        <input
                            type="checkbox"
                            checked={explicit}
                            onChange={(e) => setExplicit(e.target.checked)}
                        />
                        <span>Explicit</span>
                    </label>
                    <label className="field checkbox">
                        <input
                            type="checkbox"
                            checked={accompaniment}
                            onChange={(e) => setAccompaniment(e.target.checked)}
                        />
                        <span>Uses accompaniment</span>
                    </label>
                </div>

                <div className="field">
                    <span>Tags</span>
                    <div className="tag-picker">
                        {vocab.map((t) => (
                            <label
                                key={t.name}
                                className={`tag-chip${tagNames.has(t.name) ? " on" : ""}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={tagNames.has(t.name)}
                                    onChange={() => toggleTag(t.name)}
                                />
                                {t.name}
                                {t.category && (
                                    <span className="cat">{t.category}</span>
                                )}
                            </label>
                        ))}
                    </div>
                </div>
            </section>

            <section className="form-card">
                <p className="section-label">Parts</p>
                <div className="parts-editor">
                    {parts.map((p, i) => (
                        <div key={p.id ?? `new-${i}`} className="part-row">
                            {/* Line 1 — what the part is: name grows to fill, then the solo flag and its section. */}
                            <div className="part-line">
                                <input
                                    className="part-label"
                                    value={p.label}
                                    onChange={(e) =>
                                        setPart(i, { label: e.target.value })
                                    }
                                    placeholder="e.g. Lead, Descant"
                                />
                                <label className="part-req">
                                    <input
                                        type="checkbox"
                                        checked={p.isSolo}
                                        onChange={(e) =>
                                            setPart(
                                                i,
                                                e.target.checked
                                                    ? {
                                                          isSolo: true,
                                                          voicePartId: "",
                                                      }
                                                    : { isSolo: false },
                                            )
                                        }
                                    />
                                    solo
                                </label>
                                <select
                                    className="part-section"
                                    value={p.voicePartId}
                                    disabled={p.isSolo}
                                    onChange={(e) =>
                                        setPart(i, {
                                            voicePartId: e.target.value,
                                        })
                                    }
                                    title="Section this line needs"
                                >
                                    <option value="">
                                        {p.isSolo ? "—" : "section…"}
                                    </option>
                                    {voicePartOptions.map((vp) => (
                                        <option key={vp.id} value={vp.id}>
                                            {vp.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {/* Line 2 — how it is constrained: required, count, range; Remove pinned to the far right. */}
                            <div className="part-line">
                                <label className="part-req">
                                    <input
                                        type="checkbox"
                                        checked={p.isRequired}
                                        onChange={(e) =>
                                            setPart(i, {
                                                isRequired: e.target.checked,
                                            })
                                        }
                                    />
                                    required
                                </label>
                                <label className="part-count">
                                    count
                                    <input
                                        type="number"
                                        min={1}
                                        value={p.count}
                                        onChange={(e) =>
                                            setPart(i, {
                                                count: e.target.value,
                                            })
                                        }
                                    />
                                </label>
                                <input
                                    className="part-range"
                                    value={p.rangeLow}
                                    onChange={(e) =>
                                        setPart(i, { rangeLow: e.target.value })
                                    }
                                    placeholder="low (G3)"
                                />
                                <input
                                    className="part-range"
                                    value={p.rangeHigh}
                                    onChange={(e) =>
                                        setPart(i, {
                                            rangeHigh: e.target.value,
                                        })
                                    }
                                    placeholder="high (C6)"
                                />
                                <div className="part-actions">
                                    <button
                                        type="button"
                                        className="ctl part-move"
                                        disabled={i === 0}
                                        onClick={() => movePart(i, -1)}
                                        aria-label={`Move ${p.label || "part"} up`}
                                        title="Move up"
                                    >
                                        ↑
                                    </button>
                                    <button
                                        type="button"
                                        className="ctl part-move"
                                        disabled={i === parts.length - 1}
                                        onClick={() => movePart(i, 1)}
                                        aria-label={`Move ${p.label || "part"} down`}
                                        title="Move down"
                                    >
                                        ↓
                                    </button>
                                    <button
                                        type="button"
                                        className="ctl danger part-remove"
                                        onClick={() => removePart(i)}
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                    <button type="button" className="ctl" onClick={addPart}>
                        Add part
                    </button>
                </div>
                {hasNewRequiredPart && (
                    <p className="hint">
                        New required parts have no cover yet, so the song stays
                        uncoverable in drafts until you cast it (use Cast).
                    </p>
                )}
            </section>

            {error && <p className="callout shortfall">{error}</p>}

            <div className="form-actions">
                <button type="submit" className="perform" disabled={saving}>
                    {saving
                        ? "Saving…"
                        : mode === "edit"
                          ? "Save changes"
                          : "Add song"}
                </button>
                <Link href={`${prefix}/repertoire`} className="ctl">
                    Cancel
                </Link>
            </div>
        </form>
    );
}
