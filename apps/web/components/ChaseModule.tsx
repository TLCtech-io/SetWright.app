"use client";

import { useState } from "react";
import type { ChaseCandidate } from "@repertoire/core";
import { chaseCallList } from "@/lib/chaseMessage";
import { formatSeconds } from "@/lib/format";

// The chase lever, as one ranked, person-first list. computeChase groups by song
// (who opens each); a director's unit of action is a person, so this inverts to
// one row per singer — ordered by impact, each expandable to the songs they'd open
// and the time each adds. Collapsed by default: a scannable priority list first,
// detail on demand. Replaces the old stacked ChasePanel + ChaseCallList.
export function ChaseModule({ chase }: { chase: ChaseCandidate[] }) {
    const entries = chaseCallList(chase);
    const [open, setOpen] = useState<string | null>(null);

    if (entries.length === 0) return null;

    // Unique songs across all targets, so the summary is not inflated by a song
    // that more than one person could open.
    const songCount = new Set(chase.map((c) => c.songId)).size;

    return (
        <div className="diag-block chase-module">
            <div className="module-head">
                <h2 className="module-title">Chase to open more</h2>
                <span className="module-count">
                    {entries.length} to chase &middot; {songCount} song
                    {songCount === 1 ? "" : "s"}
                </span>
            </div>
            <p className="hint">
                These singers are unconfirmed; a yes from each opens songs they
                cover. Highest impact first.
            </p>

            <div className="chase-people">
                {entries.map((e) => {
                    const isOpen = open === e.memberId;
                    return (
                        <div
                            key={e.memberId}
                            className={`chase-person${isOpen ? " open" : ""}`}
                        >
                            <div className="chase-person-row">
                                <button
                                    type="button"
                                    className="chase-person-head"
                                    aria-expanded={isOpen}
                                    aria-controls={`chase-detail-${e.memberId}`}
                                    onClick={() =>
                                        setOpen((c) =>
                                            c === e.memberId
                                                ? null
                                                : e.memberId,
                                        )
                                    }
                                >
                                    <span className="chase-caret" aria-hidden>
                                        ▸
                                    </span>
                                    <span className="chase-who">
                                        <strong>{e.displayName}</strong>{" "}
                                        <span className="chase-parts">
                                            {e.parts.join(", ")}
                                        </span>
                                    </span>
                                    <span className="chase-impact">
                                        {e.songs.length} song
                                        {e.songs.length === 1 ? "" : "s"}{" "}
                                        <span className="gain">
                                            +{formatSeconds(e.totalSeconds)}
                                        </span>
                                    </span>
                                </button>
                            </div>

                            <div
                                className={`reveal${isOpen ? " open" : ""}`}
                                id={`chase-detail-${e.memberId}`}
                            >
                                <div className="reveal-inner">
                                    <div className="chase-detail">
                                        <ul className="chase-songs">
                                            {e.songs.map((s) => (
                                                <li key={s.title}>
                                                    <span className="chase-song-title">
                                                        {s.title}
                                                    </span>
                                                    <span className="gain">
                                                        +
                                                        {formatSeconds(
                                                            s.seconds,
                                                        )}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
