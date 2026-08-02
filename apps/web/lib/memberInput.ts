// Coerce an untrusted member-form payload into a clean MemberInput. Range notes
// arrive as scientific pitch strings ("G3") and convert to MIDI via core's one
// pitch module; role validates against a fixed set, and the section memberships
// validate against the tenant's current voice-part vocabulary.

import { midi } from "@repertoire/core";
import type {
    MemberInput,
    MemberRole,
    MemberSection,
    VoicePartRow,
} from "./db";
import { MAX_FORM_ITEMS } from "./limits";

const ROLES: MemberRole[] = ["director", "section_leader", "member"];

type Result = { ok: true; value: MemberInput } | { ok: false; error: string };

function parseNote(v: unknown): number | null {
    if (typeof v !== "string" || !v.trim()) return null;
    try {
        const n = midi(v.trim());
        return n >= 0 && n <= 127 ? n : null; // bound to the MIDI range
    } catch {
        return null; // not a valid note name
    }
}

export function coerceMemberInput(
    raw: unknown,
    voiceParts: VoicePartRow[],
): Result {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "bad body" };
    const r = raw as Record<string, unknown>;

    const displayName =
        typeof r.displayName === "string" ? r.displayName.trim() : "";
    if (!displayName) return { ok: false, error: "a name is required" };

    const role: MemberRole = ROLES.includes(r.role as MemberRole)
        ? (r.role as MemberRole)
        : "member";
    const singing = r.singing !== false; // default true; only an explicit false opts out

    // Section memberships: keep only ids in the current vocabulary, deduped. The
    // home section must be one of them; an unknown or unselected primary is dropped
    // (matches member_voice_part's one-primary-per-member rule).
    const allowed = new Set(voiceParts.map((v) => v.id));
    const voicePartIds = Array.isArray(r.voicePartIds)
        ? [
              ...new Set(
                  r.voicePartIds
                      .slice(0, MAX_FORM_ITEMS)
                      .filter(
                          (x): x is string =>
                              typeof x === "string" && allowed.has(x),
                      ),
              ),
          ]
        : [];
    // A nonempty section list that resolved to no valid ids is malformed, not an intentional clear —
    // reject rather than wipe the member's sections (an empty array clears on purpose).
    if (
        Array.isArray(r.voicePartIds) &&
        r.voicePartIds.length > 0 &&
        voicePartIds.length === 0
    ) {
        return { ok: false, error: "no valid sections in the submitted list" };
    }
    const primary =
        typeof r.primaryVoicePartId === "string" &&
        voicePartIds.includes(r.primaryVoicePartId)
            ? r.primaryVoicePartId
            : null;
    const sections: MemberSection[] = voicePartIds.map((voicePartId) => ({
        voicePartId,
        isPrimary: voicePartId === primary,
    }));

    let low = parseNote(r.rangeLow);
    let high = parseNote(r.rangeHigh);
    if (low !== null && high !== null && low > high) {
        [low, high] = [high, low]; // keep low <= high if both are given
    }

    return {
        ok: true,
        value: {
            displayName,
            role,
            singing,
            sections,
            rangeLowMidi: low,
            rangeHighMidi: high,
        },
    };
}
