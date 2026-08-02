// Presentation helpers for the Draft View. Formatting only. Key conversion is
// not here: keyLabel lives in @repertoire/core/pitch, the one home for it.

import type { KeySig, SeamFlag } from "@repertoire/core";
import { keyLabel } from "@repertoire/core";

/**
 * "Today" (YYYY-MM-DD) in the given IANA timezone — the day boundary the SQL anchors
 * to (current_date at the ensemble tz). en-CA formats as ISO YYYY-MM-DD.
 */
export function todayInTz(timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

/** Seconds to m:ss. Negative clamps to 0. */
export function formatSeconds(total: number): string {
    const s = Math.max(0, Math.round(total));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** A key for display, or a quiet placeholder when the chart carries no key. */
export function formatKey(key: KeySig | null): string {
    return key ? keyLabel(key) : "key unset";
}

/**
 * The key a song presents, showing the landing key when it modulates.
 * "G major to A major" when start and end differ, else just the one.
 */
export function formatKeyRange(
    start: KeySig | null,
    end: KeySig | null,
): string {
    if (!start) return "key unset";
    if (end && (end.fifths !== start.fifths || end.mode !== start.mode)) {
        return `${keyLabel(start)} to ${keyLabel(end)}`;
    }
    return keyLabel(start);
}

/** Tempo for display, showing a tempo change when the chart has one. */
export function formatTempo(start: number | null, end: number | null): string {
    if (start === null) return "free";
    if (end !== null && end !== start) return `${start} to ${end} bpm`;
    return `${start} bpm`;
}

/** Key · tempo · length as one line, or null when a song carries none of them. Shared by the
 * set list, the reserves, and the catalog so every surface reads a song's metadata identically. */
export function songMeta(song: {
    startKey: KeySig | null;
    endKey: KeySig | null;
    startTempoBpm: number | null;
    endTempoBpm: number | null;
    durationSeconds: number | null;
}): string | null {
    const parts = [
        formatKeyRange(song.startKey, song.endKey),
        formatTempo(song.startTempoBpm, song.endTempoBpm),
        song.durationSeconds != null
            ? formatSeconds(song.durationSeconds)
            : null,
    ].filter((x): x is string => !!x);
    return parts.length ? parts.join(" · ") : null;
}

/** An arranger credit for display. The stored value is verbatim director input, which often
 * already reads "arr. Smith" or "Trad. arr. Jones" straight off the sheet music, so only prepend
 * "arr." when the value does not already carry a credit word. null/blank → null. Render-time only,
 * so it repairs existing rows without a backfill and never mangles a formed credit. */
export function formatArrangerCredit(
    arranger: string | null | undefined,
): string | null {
    const v = arranger?.trim();
    if (!v) return null;
    return /\barr\./i.test(v) ? v : `arr. ${v}`;
}

const SEAM_LABELS: Record<SeamFlag, string> = {
    "harsh-key-change": "Harsh key change",
    "energy-flatline": "Energy flatline",
    "tempo-blur": "Tempo blur",
    "density-wall": "Density wall",
    "soloist-back-to-back": "Same soloist back to back",
    "same-feel": "Same feel",
};

export function seamFlagLabel(flag: SeamFlag): string {
    return SEAM_LABELS[flag];
}

export interface SeamFlagSummary {
    dominant: { flag: SeamFlag; label: string; count: number }[]; // flags firing across most of the set
    reduced: Map<string, SeamFlag[]>; // per fromId: flags to still show inline (dominant ones stripped)
}

// When one seam flag fires across most of a set, repeating it between every pair reads as wallpaper
// rather than signal. Fold a set-wide-dominant flag into one summary line and strip it from the
// per-seam list; a flag that fires only here and there still shows inline where it happens. The core
// flags are honest per-seam data (and intentionally sensitive), so this is presentation-only.
export function summarizeSeamFlags(
    seams: { fromId: string; flags: SeamFlag[] }[],
): SeamFlagSummary {
    const total = seams.length;
    const counts = new Map<SeamFlag, number>();
    for (const s of seams)
        for (const f of s.flags) counts.set(f, (counts.get(f) ?? 0) + 1);

    const dominantFlags = new Set<SeamFlag>();
    const dominant: SeamFlagSummary["dominant"] = [];
    for (const [flag, count] of counts) {
        // Needs a real set (>= 4 seams) and a clear majority, so a short set or an even split keeps its
        // per-seam flags rather than collapsing a signal that is not actually dominant.
        if (total >= 4 && count >= 4 && count / total >= 0.6) {
            dominantFlags.add(flag);
            dominant.push({ flag, label: seamFlagLabel(flag), count });
        }
    }

    const reduced = new Map<string, SeamFlag[]>();
    for (const s of seams)
        reduced.set(
            s.fromId,
            s.flags.filter((f) => !dominantFlags.has(f)),
        );
    return { dominant, reduced };
}

const STAGE_LABELS: Record<string, string> = {
    feasibility: "Not coverable",
    readiness: "Below readiness",
    context: "Wrong fit",
    data: "Missing data",
    capacity: "Over set cap",
};

export function dropStageLabel(stage: string): string {
    return STAGE_LABELS[stage] ?? stage;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

/** An ISO date ('2026-07-15') as 'Wed Jul 15', or 'Wed Jul 15, 2026' with { year: true }. The year
 * is opt-in for surfaces that mix past and upcoming events (the events hub, the member schedule),
 * where a bare month/day reads ambiguously; near-term single-context surfaces stay terse. Anchored
 * at noon UTC so the weekday never rolls with the server timezone. null/blank/unparseable → null. */
export function formatEventDate(
    iso: string | null | undefined,
    opts?: { year?: boolean },
): string | null {
    if (!iso) return null;
    const d = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const base = `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return opts?.year ? `${base}, ${d.getUTCFullYear()}` : base;
}

/**
 * How long ago a cover was confirmed solid, for the casting screen. Reads the
 * director's learned_at, a solid-cover fact stamped when the cover first goes
 * solid and null while it is not. `now` is injectable so the ladder is testable.
 * Buckets (this week, weeks, months, years) so an old assessment stands out
 * without false day precision.
 */
export function confirmedAgo(iso: string, now: Date = new Date()): string {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "confirmed";
    const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
    if (days <= 0) return "confirmed today";
    if (days < 7) return "confirmed this week";
    if (days < 35) {
        const w = Math.floor(days / 7);
        return `confirmed ${w} week${w === 1 ? "" : "s"} ago`;
    }
    if (days < 365) {
        const m = Math.max(1, Math.floor(days / 30.44));
        return `confirmed ${m} month${m === 1 ? "" : "s"} ago`;
    }
    const y = Math.floor(days / 365);
    return `confirmed ${y} year${y === 1 ? "" : "s"} ago`;
}
