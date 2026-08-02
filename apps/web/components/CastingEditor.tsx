"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { suggestCasting, noteName } from "@repertoire/core";
import type {
    Confidence,
    SingerProfile,
    VoicePartRange,
    PartDemand,
    PartSuggestion,
    CastingCandidate,
} from "@repertoire/core";
import type { CastingWrite, MockCasting, MockPart } from "@/lib/db";
import { confirmedAgo } from "@/lib/format";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

interface Cover {
    memberId: string;
    isPrimary: boolean;
    confidence: Confidence | null; // the member's self-report (director-set in the mock)
    directorAssessed: Confidence | null; // the director's own read, feeding the learning tracker
    // When the cover last became solid (director-only, stamped server-side). Null unless
    // it is persisted solid, so the "confirmed N ago" caption reflects saved state, not
    // an unsaved edit.
    learnedAt: string | null;
}

const CONFIDENCE: Confidence[] = ["solid", "shaky", "learning"];

// The director's per-song casting editor: assign singers to each part, mark primary vs backup
// covers, and record a confidence read. Suggestions come from core and are range-aware, recomputed
// from the live cast. Writes are director-only and use an optimistic-concurrency token so a stale
// save is rejected rather than clobbering a newer one.
export function CastingEditor({
    songId,
    songToken,
    parts,
    singers,
    voiceParts,
    initial,
    version,
}: {
    songId: string; // the song uuid, for the casting write path
    songToken: string; // the song URL token, for the Done link back to the song
    parts: MockPart[];
    singers: SingerProfile[]; // the active, singing pool with range + section eligibility
    voiceParts: VoicePartRange[]; // section nominal ranges, the fallback demand
    initial: MockCasting[];
    version: string;
}) {
    const prefix = useEnsemblePrefix();
    // Optimistic-concurrency token, advanced from each successful save (this page does not
    // navigate away, so successive casts of the same song reuse the editor).
    const [token, setToken] = useState(version);
    const nameOf = new Map(singers.map((m) => [m.memberId, m.displayName]));

    const [byPart, setByPart] = useState<Record<string, Cover[]>>(() => {
        const map: Record<string, Cover[]> = {};
        for (const p of parts) map[p.id] = [];
        for (const c of initial) {
            (map[c.partId] ??= []).push({
                memberId: c.memberId,
                isPrimary: c.isPrimary,
                confidence: c.confidence,
                directorAssessed: c.directorAssessed,
                learnedAt: c.learnedAt,
            });
        }
        return map;
    });
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(
        null,
    );

    // Range-aware suggestions, recomputed from the live cast set so a singer just
    // added drops out of the candidates. Advisory only: it never gates a save.
    const suggestions = useMemo(() => {
        const demands: PartDemand[] = parts.map((p) => ({
            partId: p.id,
            label: p.label,
            voicePartId: p.voicePartId,
            rangeLow: p.rangeLowMidi,
            rangeHigh: p.rangeHighMidi,
            castMemberIds: (byPart[p.id] ?? []).map((c) => c.memberId),
        }));
        const byId = new Map<string, PartSuggestion>();
        for (const s of suggestCasting({ parts: demands, singers, voiceParts }))
            byId.set(s.partId, s);
        return byId;
    }, [parts, singers, voiceParts, byPart]);

    // Bumped on every user edit (all mutations funnel through update). A save snapshots it and
    // only claims success if it is unchanged when the write returns, so an edit made mid-save is
    // not reported as saved. The save's own lead-normalization writes byPart directly, not through
    // update, so it never bumps this.
    const editGen = useRef(0);

    const update = (partId: string, covers: Cover[]) => {
        editGen.current += 1;
        setByPart((prev) => ({ ...prev, [partId]: covers }));
        setStatus(null);
    };

    const addCover = (partId: string, memberId: string) => {
        if (!memberId) return;
        const covers = byPart[partId] ?? [];
        if (covers.some((c) => c.memberId === memberId)) return;
        // First cover on a part defaults to the lead; the director can change it.
        update(partId, [
            ...covers,
            {
                memberId,
                isPrimary: covers.length === 0,
                confidence: null,
                directorAssessed: null,
                learnedAt: null,
            },
        ]);
    };
    const removeCover = (partId: string, memberId: string) =>
        update(
            partId,
            (byPart[partId] ?? []).filter((c) => c.memberId !== memberId),
        );
    const setPrimary = (partId: string, memberId: string) =>
        update(
            partId,
            (byPart[partId] ?? []).map((c) => ({
                ...c,
                isPrimary: c.memberId === memberId ? !c.isPrimary : false,
            })),
        );
    const setAssessment = (
        partId: string,
        memberId: string,
        directorAssessed: Confidence | null,
    ) =>
        update(
            partId,
            (byPart[partId] ?? []).map((c) =>
                c.memberId === memberId ? { ...c, directorAssessed } : c,
            ),
        );

    const save = async () => {
        setSaving(true);
        setStatus(null);
        const gen = editGen.current; // snapshot: detect edits made while this write is in flight
        // A featured part (required, single seat) with covers but no lead is
        // ambiguous: the drafter's readiness and sequence stages would each infer a
        // different lead. Designate the first cover so the lead is explicit. Reflect
        // it in the UI too, so what saved is what shows.
        const normalized: Record<string, Cover[]> = {};
        for (const p of parts) {
            const covers = byPart[p.id] ?? [];
            normalized[p.id] =
                p.isRequired &&
                p.countNeeded === 1 &&
                covers.length > 0 &&
                !covers.some((c) => c.isPrimary)
                    ? covers.map((c, i) => ({ ...c, isPrimary: i === 0 }))
                    : covers;
        }
        setByPart(normalized);

        const castings: CastingWrite[] = [];
        for (const p of parts) {
            for (const c of normalized[p.id] ?? []) {
                castings.push({
                    partId: p.id,
                    memberId: c.memberId,
                    isPrimary: c.isPrimary,
                    confidence: c.confidence,
                    directorAssessed: c.directorAssessed,
                });
            }
        }
        try {
            const res = await fetch(`/api${prefix}/songs/${songId}/casting`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ castings, expectedVersion: token }),
            });
            const body = (await res.json().catch(() => ({}))) as {
                version?: string;
                error?: string;
            };
            if (res.ok) {
                if (typeof body.version === "string") setToken(body.version);
                // Only claim a clean save if nothing changed while the write was in flight; otherwise
                // the newer edit is still unsaved and the button stays live to save it.
                setStatus(
                    editGen.current === gen
                        ? { text: "Casting saved.", ok: true }
                        : {
                              text: "Saved, but you have newer changes. Save again to apply them.",
                              ok: true,
                          },
                );
            } else {
                setStatus({
                    text: body.error ?? `Could not save (${res.status}).`,
                    ok: false,
                });
            }
        } catch {
            setStatus({ text: "Could not reach the server.", ok: false });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="casting">
            {parts.length === 0 && (
                <p className="empty">
                    This song has no parts yet. Add parts in the song editor
                    first.
                </p>
            )}

            {parts.map((part) => {
                const covers = byPart[part.id] ?? [];
                const available = singers.filter(
                    (m) => !covers.some((c) => c.memberId === m.memberId),
                );
                const covered =
                    !part.isRequired || covers.length >= part.countNeeded;
                return (
                    <div key={part.id} className="cast-part">
                        <div className="cast-part-head">
                            <span className="cast-label">{part.label}</span>
                            <span className="cast-need">
                                {part.isRequired
                                    ? `needs ${part.countNeeded}`
                                    : "optional"}
                            </span>
                            <span
                                className={`cast-status ${covered ? "ok" : "short"}`}
                            >
                                {covered
                                    ? "covered"
                                    : `short ${covers.length}/${part.countNeeded}`}
                            </span>
                        </div>

                        {covers.length === 0 && (
                            <div className="cast-empty">No one cast yet.</div>
                        )}

                        {covers.length > 0 && (
                            <div className="cast-covers">
                                <div
                                    className="cast-covers-head"
                                    aria-hidden="true"
                                >
                                    <span>Singer</span>
                                    <span>Lead</span>
                                    <span />
                                    <span>Self-report</span>
                                    <span>Your read</span>
                                    <span />
                                </div>
                                {covers.map((c) => {
                                    const name =
                                        nameOf.get(c.memberId) ?? c.memberId;
                                    return (
                                        <div
                                            key={c.memberId}
                                            className="cast-cover"
                                        >
                                            <span className="cover-name">
                                                {name}
                                            </span>
                                            <button
                                                type="button"
                                                className={`cover-lead${c.isPrimary ? " on" : ""}`}
                                                onClick={() =>
                                                    setPrimary(
                                                        part.id,
                                                        c.memberId,
                                                    )
                                                }
                                                aria-pressed={c.isPrimary}
                                                aria-label={`Featured lead: ${name}`}
                                                title={
                                                    c.isPrimary
                                                        ? "The featured lead. Click to unset"
                                                        : "Set as the featured lead"
                                                }
                                            >
                                                {c.isPrimary ? "★" : "☆"}
                                            </button>
                                            <span
                                                className="cover-spacer"
                                                aria-hidden="true"
                                            />
                                            {/* The member owns self_reported_confidence — read-only here; members set it
                                                from their own screen once the member experience lands. */}
                                            <span
                                                className="cover-selfreport"
                                                title="What the member reports about their own confidence"
                                            >
                                                {c.confidence ?? "—"}
                                            </span>
                                            <div className="cover-read-cell">
                                                <select
                                                    className="cover-read"
                                                    value={
                                                        c.directorAssessed ?? ""
                                                    }
                                                    onChange={(e) =>
                                                        setAssessment(
                                                            part.id,
                                                            c.memberId,
                                                            (e.target.value ||
                                                                null) as Confidence | null,
                                                        )
                                                    }
                                                    aria-label={`Your read on ${name}`}
                                                    title="Your assessment of where this cover stands; feeds the learning tracker"
                                                >
                                                    <option value="">
                                                        unassessed
                                                    </option>
                                                    {CONFIDENCE.map((cf) => (
                                                        <option
                                                            key={cf}
                                                            value={cf}
                                                        >
                                                            {cf}
                                                        </option>
                                                    ))}
                                                </select>
                                                {c.directorAssessed ===
                                                    "solid" &&
                                                    c.learnedAt && (
                                                        <span className="cover-confirmed">
                                                            {confirmedAgo(
                                                                c.learnedAt,
                                                            )}
                                                        </span>
                                                    )}
                                            </div>
                                            <button
                                                type="button"
                                                className="cover-remove"
                                                onClick={() =>
                                                    removeCover(
                                                        part.id,
                                                        c.memberId,
                                                    )
                                                }
                                                aria-label={`Remove ${name}`}
                                                title="Remove this cover"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {available.length > 0 && (
                            <select
                                className="cast-add"
                                value=""
                                onChange={(e) => {
                                    addCover(part.id, e.target.value);
                                    e.target.value = "";
                                }}
                            >
                                <option value="">+ add a cover…</option>
                                {available.map((m) => (
                                    <option key={m.memberId} value={m.memberId}>
                                        {m.displayName}
                                    </option>
                                ))}
                            </select>
                        )}

                        {suggestions.get(part.id) && (
                            <SuggestionPanel
                                suggestion={suggestions.get(part.id)!}
                                onAdd={(mid) => addCover(part.id, mid)}
                            />
                        )}
                    </div>
                );
            })}

            {status && (
                <p className={`status${status.ok ? "" : " error"}`}>
                    {status.text}
                </p>
            )}

            <div className="form-actions">
                <button
                    type="button"
                    className="perform"
                    disabled={saving || parts.length === 0}
                    onClick={save}
                >
                    {saving ? "Saving…" : "Save casting"}
                </button>
                <Link
                    href={`${prefix}/repertoire/${songToken}`}
                    className="ctl"
                >
                    Done
                </Link>
            </div>
        </div>
    );
}

// The range-aware "who could cover this" panel: a collapsed disclosure per part.
// Primary lists the section (or, for a solo, everyone) ranked by range fit; the
// also-consider tier lists cross-section singers whose range genuinely covers the
// line. All advisory: adding a candidate is the same as any other cast.
function SuggestionPanel({
    suggestion: s,
    onAdd,
}: {
    suggestion: PartSuggestion;
    onAdd: (memberId: string) => void;
}) {
    const demandKnown =
        s.isPitched && s.demandLow !== null && s.demandHigh !== null;
    const rangeMissing = s.isPitched && !demandKnown;
    const hasCandidates = s.primary.length > 0 || s.alsoConsider.length > 0;
    // One empty-state, decided once, so the hints never contradict each other:
    //  - 'empty': nobody to suggest (even a solo whose range is unset).
    //  - 'solo-needs-range': a solo with no range would list the whole roster unranked,
    //    so prompt for a range instead of the noise.
    //  - 'list': show the groups, with a range prompt above them for a section that has
    //    eligible members but no demand to rank them by.
    const mode: "empty" | "solo-needs-range" | "list" = !hasCandidates
        ? "empty"
        : s.isSolo && rangeMissing
          ? "solo-needs-range"
          : "list";

    return (
        <details className="cast-suggest">
            <summary>
                <span>Who could cover this</span>
                {demandKnown && (
                    <span className="suggest-demand">
                        needs {noteName(s.demandLow!)}–{noteName(s.demandHigh!)}
                    </span>
                )}
            </summary>
            <div className="suggest-body">
                {mode === "empty" && (
                    <p className="suggest-hint">
                        No one else to suggest for this part.
                    </p>
                )}
                {mode === "solo-needs-range" && (
                    <p className="suggest-hint">
                        Add a range to this solo to rank singers by fit.
                    </p>
                )}
                {mode === "list" && (
                    <>
                        {rangeMissing && (
                            <p className="suggest-hint">
                                Add a range to this part or its section to rank
                                singers by fit.
                            </p>
                        )}
                        <SuggestGroup
                            title={s.isSolo ? "Best fit" : "In section"}
                            candidates={s.primary}
                            showFit={demandKnown}
                            onAdd={onAdd}
                        />
                        <SuggestGroup
                            title="Also consider"
                            candidates={s.alsoConsider}
                            showFit={demandKnown}
                            onAdd={onAdd}
                        />
                    </>
                )}
            </div>
        </details>
    );
}

function SuggestGroup({
    title,
    candidates,
    showFit,
    onAdd,
}: {
    title: string;
    candidates: CastingCandidate[];
    showFit: boolean;
    onAdd: (memberId: string) => void;
}) {
    if (candidates.length === 0) return null;
    return (
        <div className="suggest-group">
            <p className="suggest-group-title">{title}</p>
            {candidates.map((c) => {
                const f = describeFit(c);
                return (
                    <div key={c.memberId} className="suggest-row">
                        <span className="suggest-name">{c.displayName}</span>
                        {showFit && (
                            <span className={`suggest-fit ${f.cls}`}>
                                {f.label}
                            </span>
                        )}
                        {showFit && f.note && (
                            <span className="suggest-note">{f.note}</span>
                        )}
                        <button
                            type="button"
                            className="suggest-add"
                            onClick={() => onAdd(c.memberId)}
                        >
                            + add
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

function describeFit(c: CastingCandidate): {
    label: string;
    note: string;
    cls: string;
} {
    switch (c.fit) {
        case "comfortable":
            return { label: "comfortable", note: "", cls: "fit-comfortable" };
        case "edge":
            return { label: "edge", note: shortNote(c), cls: "fit-edge" };
        case "out-of-range":
            return {
                label: "out of range",
                note: shortNote(c),
                cls: "fit-out",
            };
        default:
            return { label: "range not set", note: "", cls: "fit-unknown" };
    }
}

// Where the line's demand sits outside the singer's range, in semitones, for the
// fit note. A negative headroom means the demanded note is past what they reach:
// the top note too high for them, or the low note too low.
function shortNote(c: CastingCandidate): string {
    const parts: string[] = [];
    if (c.headroomLow !== null && c.headroomLow < 0)
        parts.push(`low note ${-c.headroomLow} semitones too low`);
    if (c.headroomHigh !== null && c.headroomHigh < 0)
        parts.push(`top note ${-c.headroomHigh} semitones too high`);
    return parts.join(", ");
}
