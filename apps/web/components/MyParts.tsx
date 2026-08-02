"use client";

import { useMemo, useState } from "react";
import type { AssessedReadiness, Confidence } from "@repertoire/core";
import { noteName, tonicName } from "@repertoire/core";
import type { MyCasting, PartCoverage } from "@/lib/db";
import { formatKeyRange, formatTempo } from "@/lib/format";
import { Badge, type BadgeTone } from "./Badge";
import { useEnsemblePrefix } from "@/lib/useEnsemblePath";

// A cover's self-report, phrased for the reader. Others' confidence is null unless the ensemble
// shares it, so null reads as nothing rather than a guess.
const CONF_LABEL: Record<Confidence, string> = {
    solid: "solid",
    shaky: "shaky",
    learning: "learning",
};
const confLabel = (c: Confidence | null): string | null =>
    c ? CONF_LABEL[c] : null;

const LEVELS: { value: Confidence | ""; label: string }[] = [
    { value: "", label: "Not reported" },
    { value: "learning", label: "Still learning" },
    { value: "shaky", label: "Shaky" },
    { value: "solid", label: "Solid" },
];

// The director's read of the whole song, shown as a scannable badge in the row header.
const READINESS: Record<AssessedReadiness, { label: string; tone: BadgeTone }> =
    {
        "performance-ready": { label: "Ready", tone: "ready" },
        "needs-polish": { label: "Polishing", tone: "polish" },
        learning: { label: "Learning", tone: "learn" },
        dormant: { label: "Dormant", tone: "low" },
    };

type PartSort = "readiness" | "song";
type PartFilter = "all" | "unrated" | "learning" | "shaky" | "solid";
// The sort key for "weakest first": still-to-rate, then weakest to strongest self-read.
const READINESS_RANK: Record<Confidence, number> = {
    learning: 1,
    shaky: 2,
    solid: 3,
};
const readinessRank = (c: Confidence | null) =>
    c == null ? 0 : READINESS_RANK[c];

// The pitch a member blows to find their note: the song's explicit start pitch, else the
// start key's tonic (spelled per the key), the same rule the printable sheet uses.
const pitchToBlow = (p: MyCasting): string | null =>
    p.startPitch ?? (p.startKey ? tonicName(p.startKey) : null);

// A solo names its own range, so it can be sized against the member's own range. Section
// lines inherit their section nominal and carry no part range, so they get no fit line.
function RangeFit({
    low,
    high,
    memberLow,
    memberHigh,
}: {
    low: number;
    high: number;
    memberLow: number | null;
    memberHigh: number | null;
}) {
    if (memberLow == null || memberHigh == null) {
        return <span className="mypart-fit muted">your range is not set</span>;
    }
    const below = low < memberLow;
    const above = high > memberHigh;
    const yours = `${noteName(memberLow)}–${noteName(memberHigh)}`;
    if (!below && !above)
        return (
            <span className="mypart-fit ok">within your range ({yours})</span>
        );
    const where =
        below && above
            ? "beyond your range at both ends"
            : below
              ? "below your range"
              : "above your range";
    return (
        <span className="mypart-fit warn">
            reaches {where} ({yours})
        </span>
    );
}

function ChartLink({ chartRef }: { chartRef: string | null }) {
    if (!chartRef)
        return <span className="mypart-nochart">No chart on file.</span>;
    if (/^https?:\/\//i.test(chartRef)) {
        return (
            <a
                className="mypart-chartlink"
                href={chartRef}
                target="_blank"
                rel="noopener noreferrer"
            >
                Open chart
            </a>
        );
    }
    return (
        <span className="mypart-nochart">
            Chart: <span className="mono">{chartRef}</span>
        </span>
    );
}

// The member's cast parts as a practice list. Each row shows the song, part, and the
// director's readiness at a glance, plus the member's own self-confidence select. Expanding
// a row reveals what a member needs to prepare it: the pitch to blow, key, tempo, chart, and
// for solos how the line sits against their own range.
//
// The self-confidence select writes only the member's own casting row (PUT .../me/confidence
// -> set_my_confidence) optimistically, rolling back on failure. Only the member and their
// director ever see this value. In-flight writes are tracked PER part id and re-entrancy is
// blocked with an early return rather than by disabling the just-changed <select> (disabling
// the focused control would drop keyboard/AT focus to <body>). Errors are per row.
export function MyParts({
    parts,
    memberLow,
    memberHigh,
    coverage,
}: {
    parts: MyCasting[];
    memberLow: number | null;
    memberHigh: number | null;
    coverage: PartCoverage[];
}) {
    const prefix = useEnsemblePrefix();
    const coverageByPart = useMemo(
        () => new Map(coverage.map((c) => [c.partId, c])),
        [coverage],
    );
    const [conf, setConf] = useState<Record<string, Confidence | null>>(
        Object.fromEntries(parts.map((p) => [p.partId, p.confidence])),
    );
    const [inflight, setInflight] = useState<Set<string>>(new Set());
    const [failed, setFailed] = useState<Set<string>>(new Set());
    const [open, setOpen] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<PartSort>("readiness");
    const [filter, setFilter] = useState<PartFilter>("all");

    const without = (s: Set<string>, id: string) => {
        const n = new Set(s);
        n.delete(id);
        return n;
    };

    const toggle = (id: string) =>
        setOpen((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    async function set(partId: string, value: Confidence | null) {
        if (inflight.has(partId)) return; // block re-entrancy without disabling the focused select
        const prev = conf[partId] ?? null;
        setInflight((s) => new Set(s).add(partId));
        setFailed((s) => without(s, partId));
        setConf((c) => ({ ...c, [partId]: value }));
        let ok = false;
        try {
            const res = await fetch(`/api${prefix}/me/confidence`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ partId, confidence: value }),
            });
            ok = res.ok;
        } catch {
            ok = false;
        }
        setInflight((s) => without(s, partId));
        if (!ok) {
            setConf((c) => ({ ...c, [partId]: prev }));
            setFailed((s) => new Set(s).add(partId));
        }
    }

    // How many parts the member has not yet marked solid: the practice load. Reads the live edit
    // state, not the prop, so it tracks a confidence change immediately (and reverts with a failed
    // save) — the count moves no rows, so unlike the list order it has no reason to stay frozen.
    const toSolidify = parts.filter(
        (p) => (conf[p.partId] ?? null) !== "solid",
    ).length;

    // Client-side search, filter, and sort. Filter and sort read the initial confidence from
    // props, not the live edit state, so rating a part never reorders or drops its row from
    // under the cursor — the row stays put (its select just updates) and refreshes on the next load.
    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = parts.filter((p) => {
            if (filter === "unrated" && p.confidence != null) return false;
            if (
                filter !== "all" &&
                filter !== "unrated" &&
                p.confidence !== filter
            )
                return false;
            if (needle && !p.songTitle.toLowerCase().includes(needle))
                return false;
            return true;
        });
        const byTitle = (a: MyCasting, b: MyCasting) =>
            a.songTitle.localeCompare(b.songTitle);
        return [...filtered].sort((a, b) =>
            sort === "readiness"
                ? readinessRank(a.confidence) - readinessRank(b.confidence) ||
                  byTitle(a, b)
                : byTitle(a, b),
        );
    }, [parts, query, sort, filter]);

    return (
        <>
            <p className="myparts-summary">
                {toSolidify > 0
                    ? `${toSolidify} of ${parts.length} part${parts.length === 1 ? "" : "s"} still to get solid.`
                    : `All ${parts.length} part${parts.length === 1 ? "" : "s"} solid.`}
            </p>

            <div className="songs-toolbar">
                <input
                    className="songs-search"
                    type="text"
                    placeholder="Search your songs…"
                    aria-label="Search your songs"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <div className="songs-controls">
                    <select
                        className="songs-select"
                        value={sort}
                        onChange={(e) => setSort(e.target.value as PartSort)}
                        aria-label="Sort by"
                    >
                        <option value="readiness">Sort: Weakest first</option>
                        <option value="song">Sort: Song</option>
                    </select>
                    <select
                        className="songs-select"
                        value={filter}
                        onChange={(e) =>
                            setFilter(e.target.value as PartFilter)
                        }
                        aria-label="Filter parts"
                    >
                        <option value="all">All parts</option>
                        <option value="unrated">To rate</option>
                        <option value="learning">Learning</option>
                        <option value="shaky">Shaky</option>
                        <option value="solid">Solid</option>
                    </select>
                </div>
            </div>

            <p
                className="songs-count"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {shown.length} of {parts.length} song
                {parts.length === 1 ? "" : "s"}
            </p>

            {shown.length === 0 ? (
                <p className="songs-empty">No parts match.</p>
            ) : (
                <ul className="myparts-list">
                    {shown.map((p) => {
                        const isOpen = open.has(p.partId);
                        const readiness = READINESS[p.assessedReadiness] ?? {
                            label: p.assessedReadiness,
                            tone: "low" as BadgeTone,
                        };
                        const pitch = pitchToBlow(p);
                        const cov = coverageByPart.get(p.partId);
                        const detailId = `mypart-detail-${p.partId}`;
                        return (
                            <li
                                key={p.partId}
                                className="mypart"
                                aria-busy={inflight.has(p.partId)}
                            >
                                <div className="mypart-row">
                                    <button
                                        type="button"
                                        className="mypart-disclosure"
                                        aria-expanded={isOpen}
                                        aria-controls={detailId}
                                        onClick={() => toggle(p.partId)}
                                    >
                                        <span className="mypart-lead">
                                            <span
                                                className="mypart-caret"
                                                aria-hidden="true"
                                            >
                                                ▸
                                            </span>
                                            <span className="mypart-headline">
                                                <span className="mypart-song">
                                                    {p.songTitle}
                                                </span>
                                                <span className="mypart-part">
                                                    {p.partLabel}
                                                </span>
                                                {/* Flag a featured lead, unless the part is literally the Lead line already. */}
                                                {p.isLead &&
                                                    p.partLabel.toLowerCase() !==
                                                        "lead" && (
                                                        <span className="role-tag">
                                                            lead
                                                        </span>
                                                    )}
                                            </span>
                                        </span>
                                        <span className="mypart-badges">
                                            <Badge
                                                label={readiness.label}
                                                tone={readiness.tone}
                                            />
                                            {p.bookStatus === "on-book" && (
                                                <span className="song-flag book">
                                                    on book
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                    <label className="cover-conf mypart-conf">
                                        <select
                                            aria-label={`Your confidence on ${p.songTitle}`}
                                            value={conf[p.partId] ?? ""}
                                            onChange={(e) =>
                                                set(
                                                    p.partId,
                                                    (e.target.value ||
                                                        null) as Confidence | null,
                                                )
                                            }
                                        >
                                            {LEVELS.map((l) => (
                                                <option
                                                    key={l.value}
                                                    value={l.value}
                                                >
                                                    {l.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>

                                {failed.has(p.partId) && (
                                    <p className="mypart-error" role="alert">
                                        Could not save. Try again.
                                    </p>
                                )}

                                <div
                                    className={`reveal${isOpen ? " open" : ""}`}
                                >
                                    <div className="reveal-inner">
                                        <div
                                            className="mypart-detail"
                                            id={detailId}
                                            inert={isOpen ? undefined : true}
                                        >
                                            <dl className="mypart-facts">
                                                <div className="mypart-fact mypart-fact-pitch">
                                                    <dt>Starting pitch</dt>
                                                    <dd className="mono">
                                                        {pitch ?? "—"}
                                                    </dd>
                                                </div>
                                                <div className="mypart-fact">
                                                    <dt>Key</dt>
                                                    <dd className="mono">
                                                        {formatKeyRange(
                                                            p.startKey,
                                                            p.endKey,
                                                        )}
                                                    </dd>
                                                </div>
                                                <div className="mypart-fact">
                                                    <dt>Tempo</dt>
                                                    <dd className="mono">
                                                        {formatTempo(
                                                            p.startTempoBpm,
                                                            p.endTempoBpm,
                                                        )}
                                                    </dd>
                                                </div>
                                            </dl>
                                            <div className="mypart-meta-row">
                                                <ChartLink
                                                    chartRef={p.chartRef}
                                                />
                                                {p.isSolo &&
                                                    p.rangeLowMidi != null &&
                                                    p.rangeHighMidi != null && (
                                                        <span className="mypart-range">
                                                            <span className="mypart-range-label">
                                                                Solo range
                                                            </span>
                                                            <span className="mono">
                                                                {noteName(
                                                                    p.rangeLowMidi,
                                                                )}
                                                                {"–"}
                                                                {noteName(
                                                                    p.rangeHighMidi,
                                                                )}
                                                            </span>
                                                            <RangeFit
                                                                low={
                                                                    p.rangeLowMidi
                                                                }
                                                                high={
                                                                    p.rangeHighMidi
                                                                }
                                                                memberLow={
                                                                    memberLow
                                                                }
                                                                memberHigh={
                                                                    memberHigh
                                                                }
                                                            />
                                                        </span>
                                                    )}
                                            </div>
                                            {cov && (
                                                <div className="mypart-coverage">
                                                    <span className="mypart-range-label">
                                                        Coverage
                                                    </span>
                                                    <span className="mono">
                                                        needs {cov.countNeeded}{" "}
                                                        · cast{" "}
                                                        {cov.covers.length}
                                                    </span>
                                                    {cov.covers.length <
                                                    cov.countNeeded ? (
                                                        <span className="mypart-fit warn">
                                                            short{" "}
                                                            {cov.countNeeded -
                                                                cov.covers
                                                                    .length}
                                                        </span>
                                                    ) : cov.covers.length >
                                                      cov.countNeeded ? (
                                                        <span className="mypart-fit ok">
                                                            backup
                                                        </span>
                                                    ) : (
                                                        <span className="mypart-fit muted">
                                                            no backup
                                                        </span>
                                                    )}
                                                    <span className="mypart-covers">
                                                        {cov.covers.map((c) => {
                                                            // The viewer's own cover reads the live edit state so it agrees with the
                                                            // select above it; a peer's confidence is the server snapshot (it can't change here).
                                                            const cl =
                                                                confLabel(
                                                                    c.isSelf
                                                                        ? (conf[
                                                                              p
                                                                                  .partId
                                                                          ] ??
                                                                              null)
                                                                        : c.confidence,
                                                                );
                                                            return (
                                                                <span
                                                                    key={
                                                                        c.memberId
                                                                    }
                                                                    className="mypart-cover"
                                                                >
                                                                    {c.isSelf
                                                                        ? "you"
                                                                        : c.displayName}
                                                                    {c.isLead
                                                                        ? " (lead)"
                                                                        : ""}
                                                                    {cl
                                                                        ? ` · ${cl}`
                                                                        : ""}
                                                                </span>
                                                            );
                                                        })}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </>
    );
}
