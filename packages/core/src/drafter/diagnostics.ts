// The shortfall diagnostic.
//
// When the pool cannot fill the target, say why in plain terms, and name the
// lever. "VP out removes 6 minutes" turns a thin night into a decision.

import type { Song } from "../types.js";

export interface Drop {
    song: Song;
    stage: "feasibility" | "readiness" | "context" | "data" | "capacity";
    detail: string;
    stageSeconds: number; // padded time the song would have used; 0 when unknown
}

const min = (sec: number): number => Math.round(sec / 60);
const plural = (n: number): string => (n > 1 ? "s" : "");

// How many per-part feasibility levers to name before rolling the rest into one summary line.
const SHORTFALL_TOP = 5;

export function renderShortfall(args: {
    targetSeconds: number;
    filledSeconds: number;
    drops: Drop[];
    requiredMisses?: string[];
    overCapSeconds?: number; // seconds the set runs over the hard cap; 0 = within it
    capSeconds?: number | null; // the hard cap, for the message
}): string {
    const {
        targetSeconds,
        filledSeconds,
        drops,
        requiredMisses = [],
        overCapSeconds = 0,
        capSeconds = null,
    } = args;
    const lines: string[] = [];

    // Over the hard cap comes first: it is the most urgent lever (the set is too long, not too
    // thin). Only pins, forced keeps, or long segues can cause it, so name that as the fix.
    if (overCapSeconds > 0 && capSeconds !== null) {
        lines.push(
            `${min(overCapSeconds)} min over the ${min(capSeconds)}-minute cap. Unpin a song or shorten a segue.`,
        );
    }

    // The fill headline only when the set is actually short of the target; a require-only
    // miss (target met, mandate unmet) skips it and goes straight to the lever.
    if (filledSeconds < targetSeconds) {
        lines.push(
            `${min(filledSeconds)} of ${min(targetSeconds)} minutes filled from ready, coverable, appropriate songs.`,
        );
    }

    // Feasibility, aggregated by the part that could not be covered.
    const byPart = new Map<string, { count: number; seconds: number }>();
    for (const d of drops.filter((d) => d.stage === "feasibility")) {
        const cur = byPart.get(d.detail) ?? { count: 0, seconds: 0 };
        cur.count += 1;
        cur.seconds += d.stageSeconds;
        byPart.set(d.detail, cur);
    }
    // Highest-impact lever first (most minutes recovered), and capped: a wide shortfall would
    // otherwise bury the biggest recast under a wall of lines in insertion (song) order. The
    // overflow is summed into one line so the minutes still reconcile.
    const feasParts = [...byPart.entries()]
        .map(([label, agg]) => ({
            label: label || "a required part",
            count: agg.count,
            seconds: agg.seconds,
        }))
        .sort(
            (a, b) =>
                b.seconds - a.seconds ||
                b.count - a.count ||
                a.label.localeCompare(b.label),
        );
    for (const p of feasParts.slice(0, SHORTFALL_TOP)) {
        lines.push(
            `${p.label} uncovered removes ${min(p.seconds)} min (${p.count} song${plural(p.count)}).`,
        );
    }
    const feasRest = feasParts.slice(SHORTFALL_TOP);
    if (feasRest.length) {
        const restSongs = feasRest.reduce((n, p) => n + p.count, 0);
        const restSecs = feasRest.reduce((n, p) => n + p.seconds, 0);
        lines.push(
            `${feasRest.length} more part${plural(feasRest.length)} uncovered (${min(restSecs)} min, ${restSongs} song${plural(restSongs)}).`,
        );
    }

    // Readiness floor exclusions.
    const floor = drops.filter(
        (d) => d.stage === "readiness" && d.detail.includes("below floor"),
    );
    if (floor.length) {
        const secs = floor.reduce((s, d) => s + d.stageSeconds, 0);
        // Tier-neutral: the dropped songs may be needs-polish, learning, or dormant,
        // so name the bar, not one tier, or the lever points at songs it would not admit.
        lines.push(
            `${floor.length} song${plural(floor.length)} (${min(secs)} min) below the readiness bar, available if you lower it.`,
        );
    }

    // Off-book-only exclusions.
    const mode = drops.filter(
        (d) => d.stage === "readiness" && d.detail.includes("mode"),
    );
    if (mode.length) {
        const secs = mode.reduce((s, d) => s + d.stageSeconds, 0);
        lines.push(
            `${mode.length} on-book song${plural(mode.length)} (${min(secs)} min) excluded because this event is off-book only.`,
        );
    }

    // Explicit gate. Native now, separate from tag exclusions.
    const explicit = drops.filter(
        (d) => d.stage === "context" && d.detail === "explicit",
    );
    if (explicit.length) {
        const secs = explicit.reduce((s, d) => s + d.stageSeconds, 0);
        lines.push(
            `${explicit.length} song${plural(explicit.length)} (${min(secs)} min) removed as explicit for this audience.`,
        );
    }

    // Accompaniment gate. Native, separate from tag exclusions, mirrors explicit.
    const accompaniment = drops.filter(
        (d) => d.stage === "context" && d.detail === "accompaniment",
    );
    if (accompaniment.length) {
        const secs = accompaniment.reduce((s, d) => s + d.stageSeconds, 0);
        lines.push(
            `${accompaniment.length} song${plural(accompaniment.length)} (${min(secs)} min) removed, a cappella only.`,
        );
    }

    // Other context exclusions (exclude tags).
    const ctx = drops.filter(
        (d) =>
            d.stage === "context" &&
            d.detail !== "explicit" &&
            d.detail !== "accompaniment",
    );
    if (ctx.length) {
        const secs = ctx.reduce((s, d) => s + d.stageSeconds, 0);
        lines.push(
            `${ctx.length} song${plural(ctx.length)} (${min(secs)} min) removed as a poor fit for this event.`,
        );
    }

    // Data gaps: songs that cleared every gate but carry no chart length, so they
    // cannot be length-placed. The lever is the duration field, not the roster.
    const data = drops.filter((d) => d.stage === "data");
    if (data.length) {
        lines.push(
            `${data.length} song${plural(data.length)} with no length set, draftable once durations are added.`,
        );
    }

    // Pins that overflowed the sequencer cap (a pathological over-cap pin payload).
    const capacity = drops.filter((d) => d.stage === "capacity");
    if (capacity.length) {
        lines.push(
            `${capacity.length} pinned song${plural(capacity.length)} dropped over the sequencer cap.`,
        );
    }

    // Required-material misses: a mandated tag no available song carries. Name the lever.
    for (const tag of requiredMisses) {
        lines.push(
            `No available song carries the required tag "${tag}", which this event mandates.`,
        );
    }

    return lines.join(" ");
}
