"use client";

import { useMemo, useState } from "react";
import type { AvailabilityStatus } from "@repertoire/core";
import { whatIf, type SongCoverage } from "@/lib/insights";

const STATUSES: AvailabilityStatus[] = ["in", "tentative", "out"];
const LABEL: Record<AvailabilityStatus, string> = {
    in: "In",
    tentative: "Maybe",
    out: "Out",
};

export interface WhatIfMember {
    id: string;
    displayName: string;
    status: AvailabilityStatus;
}

// Client-side what-if. The director toggles each member's availability; coverage
// recomputes locally (the matcher is pure and cheap) and diffs against the saved
// baseline. No server round-trip: all the data arrived with the page.
export function WhatIfPanel({
    members,
    coverage,
}: {
    members: WhatIfMember[];
    coverage: SongCoverage[];
}) {
    const [sim, setSim] = useState<Record<string, AvailabilityStatus>>(() =>
        Object.fromEntries(members.map((m) => [m.id, m.status])),
    );

    const baselineIn = useMemo(
        () =>
            new Set(members.filter((m) => m.status === "in").map((m) => m.id)),
        [members],
    );

    const result = useMemo(() => {
        const availableNow = new Set(
            members
                .filter((m) => (sim[m.id] ?? m.status) === "in")
                .map((m) => m.id),
        );
        return whatIf(coverage, availableNow, baselineIn);
    }, [sim, members, coverage, baselineIn]);

    const dirty = members.some((m) => (sim[m.id] ?? m.status) !== m.status);
    const uncoverable = result.rows.filter((r) => !r.feasible);

    return (
        <div className="whatif">
            <div className="whatif-roster">
                {members.map((m) => {
                    const cur = sim[m.id] ?? m.status;
                    return (
                        <div key={m.id} className="whatif-member">
                            <span className="whatif-name">{m.displayName}</span>
                            <div className="whatif-toggles">
                                {STATUSES.map((s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        className={`ctl whatif-toggle ${s}${cur === s ? " on" : ""}`}
                                        aria-pressed={cur === s}
                                        onClick={() =>
                                            setSim((prev) => ({
                                                ...prev,
                                                [m.id]: s,
                                            }))
                                        }
                                    >
                                        {LABEL[s]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div
                className={`whatif-result ${result.coverableCount === result.rows.length ? "good" : "warn"}`}
            >
                <div className="whatif-result-figure">
                    <span className="whatif-result-count">
                        {result.coverableCount}/{result.rows.length}
                    </span>
                    <span className="whatif-result-label">songs coverable</span>
                </div>
                <div className="whatif-result-delta">
                    {!dirty ? (
                        <span className="muted">On the saved RSVPs</span>
                    ) : result.broke.length === 0 &&
                      result.unlocked.length === 0 ? (
                        <span className="muted">No change from the RSVPs</span>
                    ) : (
                        <>
                            {result.broke.length > 0 && (
                                <span className="delta break">
                                    {result.broke.length} break
                                    {result.broke.length === 1 ? "" : "s"}
                                </span>
                            )}
                            {result.unlocked.length > 0 && (
                                <span className="delta unlock">
                                    {result.unlocked.length} unlock
                                    {result.unlocked.length === 1 ? "" : "s"}
                                </span>
                            )}
                        </>
                    )}
                </div>
                {dirty && (
                    <button
                        type="button"
                        className="ctl whatif-reset"
                        onClick={() =>
                            setSim(
                                Object.fromEntries(
                                    members.map((m) => [m.id, m.status]),
                                ),
                            )
                        }
                    >
                        Reset to RSVPs
                    </button>
                )}
            </div>

            {result.broke.length > 0 && (
                <div className="callout broke">
                    <h2>Breaks ({result.broke.length})</h2>
                    {result.broke.map((r) => (
                        <div key={r.songId}>{r.title}</div>
                    ))}
                </div>
            )}

            {result.unlocked.length > 0 && (
                <div className="callout unlocked">
                    <h2>Unlocks ({result.unlocked.length})</h2>
                    {result.unlocked.map((r) => (
                        <div key={r.songId}>{r.title}</div>
                    ))}
                </div>
            )}

            <div className="whatif-uncoverable">
                <p className="section-label">
                    Uncoverable under this scenario ({uncoverable.length})
                </p>
                {uncoverable.length === 0 ? (
                    <p className="empty">Every song can be cast.</p>
                ) : (
                    <div className="rep-list">
                        {uncoverable.map((r) => {
                            const broke = result.broke.some(
                                (b) => b.songId === r.songId,
                            );
                            return (
                                <div
                                    key={r.songId}
                                    className={`insight-row ${broke ? "single-point" : "undercast"}`}
                                >
                                    <div className="rep-body">
                                        <div className="rep-title">
                                            {r.title}
                                        </div>
                                        {broke && (
                                            <div className="rep-meta">
                                                Coverable on the saved RSVPs.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
