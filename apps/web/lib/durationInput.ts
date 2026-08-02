// Parse a duration field. '' is empty (no duration), 'm:ss' or a plain positive integer parse to
// seconds, anything else is invalid (distinct from empty, e.g. '4:60' is not 4). Shared by the
// event and song forms so an accepted format never drifts between them.

export type DurationParse = number | null | "invalid";

export function parsePositiveDuration(v: string): DurationParse {
    const t = v.trim();
    if (!t) return null;
    if (t.includes(":")) {
        const mmss = /^(\d+):([0-5]\d)$/.exec(t);
        if (!mmss) return "invalid";
        const total = Number(mmss[1]) * 60 + Number(mmss[2]);
        return total > 0 ? total : "invalid"; // '0:00' is not a valid duration
    }
    return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : "invalid";
}
