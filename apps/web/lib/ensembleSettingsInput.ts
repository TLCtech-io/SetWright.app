// Coercer for the ensemble settings form (name, timezone, confidence visibility). Mirrors
// the other *Input coercers: trims/validates and returns {ok,value}|{ok:false,error}.
import type { ConfidenceVisibility, EnsembleSettingsInput } from "./db";
import { COMMON_TIMEZONES } from "./timezones";

type Result =
    | { ok: true; value: EnsembleSettingsInput }
    | { ok: false; error: string };

const MAX_NAME = 80;
const VISIBILITY: ConfidenceVisibility[] = ["private", "shared"];

export function coerceEnsembleSettings(raw: unknown): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const name = (typeof r.name === "string" ? r.name.trim() : "").slice(
        0,
        MAX_NAME,
    );
    if (!name) return { ok: false, error: "an ensemble name is required" };

    const timezone = typeof r.timezone === "string" ? r.timezone : "";
    if (!(COMMON_TIMEZONES as readonly string[]).includes(timezone)) {
        return { ok: false, error: "unknown timezone" };
    }

    const confidenceVisibility = VISIBILITY.includes(
        r.confidenceVisibility as ConfidenceVisibility,
    )
        ? (r.confidenceVisibility as ConfidenceVisibility)
        : null;
    if (confidenceVisibility === null) {
        return { ok: false, error: "visibility must be private or shared" };
    }

    return { ok: true, value: { name, timezone, confidenceVisibility } };
}
