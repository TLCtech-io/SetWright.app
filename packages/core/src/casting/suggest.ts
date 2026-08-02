// Range-aware casting suggestions.
//
// The funnel is range-blind on purpose: castings encode who covers a part, so
// feasibility never reads range (see drafter/feasibility.ts). This is the other
// side of that coin. It answers a question the funnel does not: for a line nobody
// is cast on yet, who COULD sing it? It ranks uncast members by whether their
// vocal range covers the line's demand, so casting becomes review-and-confirm,
// not recall.
//
// Advisory only. Every range field is nullable and often unset, so a missing
// range is "no signal", never a strike: the pass annotates and ranks, it never
// gates a song or reorders the draft. It composes onto the casting screen the way
// computeChase composes onto the draft result, with its own input, not DraftInput.

import type { ID, MidiPitch } from "../types.js";

/** A singer the pass can suggest, with the range and section eligibility it ranks on. */
export interface SingerProfile {
    memberId: ID;
    displayName: string;
    rangeLow: MidiPitch | null; // vocal_range_low; null = not stated
    rangeHigh: MidiPitch | null; // vocal_range_high
    sections: ID[]; // voice_part_ids the member is eligible for (member_voice_part)
    homeSection: ID | null; // the primary section; a tie-break and a display hint only
}

/** A section's typical range, the fallback demand for a section line that names none. */
export interface VoicePartRange {
    voicePartId: ID;
    nominalLow: MidiPitch | null;
    nominalHigh: MidiPitch | null;
    isPitched: boolean; // false = vocal percussion; range fit is meaningless there
}

/** One line to cover, its demanded range, and who already covers it. */
export interface PartDemand {
    partId: ID;
    label: string;
    voicePartId: ID | null; // the section this line needs; null = a solo (no section)
    rangeLow: MidiPitch | null; // the line's own demand; usually set only for solos
    rangeHigh: MidiPitch | null;
    castMemberIds: ID[]; // already covering it, excluded from the candidates
}

export interface CastingSuggestionInput {
    parts: PartDemand[];
    singers: SingerProfile[];
    voiceParts: VoicePartRange[];
}

// How well a singer's range covers a line. Comfortable clears both ends with room,
// edge just clears or just misses within the tolerance, out-of-range misses by more,
// unknown means a range is unstated (either side) or the line has no pitched demand.
export type RangeFit = "comfortable" | "edge" | "out-of-range" | "unknown";

export interface CastingCandidate {
    memberId: ID;
    displayName: string;
    fit: RangeFit;
    headroomLow: number | null; // semitones the singer clears the demand low by; negative = short
    headroomHigh: number | null; // semitones the singer clears the demand high by; negative = short
    isHomeSection: boolean; // this line's section is the member's primary (tie-break, display)
}

export interface PartSuggestion {
    partId: ID;
    label: string;
    demandLow: MidiPitch | null; // the resolved demand: the part's own range, else the section nominal
    demandHigh: MidiPitch | null;
    isPitched: boolean; // false = range fit does not apply (vocal percussion)
    isSolo: boolean; // true = no section; primary holds every candidate ranked by fit
    primary: CastingCandidate[]; // section-eligible members (or, for a solo, all), best fit first
    alsoConsider: CastingCandidate[]; // cross-section members whose range fits; empty for solo/non-pitched
}

// Within this many semitones of a demand bound a fit is "edge": a near-miss worth
// showing (a good day, or a whole-step transpose, covers it), not a comfortable yes.
const EDGE_SEMITONES = 2;

const FIT_RANK: Record<RangeFit, number> = {
    comfortable: 0,
    edge: 1,
    "out-of-range": 2,
    unknown: 3,
};

export function suggestCasting(
    input: CastingSuggestionInput,
): PartSuggestion[] {
    const vpById = new Map(input.voiceParts.map((v) => [v.voicePartId, v]));

    return input.parts.map((part) => {
        const section =
            part.voicePartId !== null
                ? (vpById.get(part.voicePartId) ?? null)
                : null;
        const isSolo = part.voicePartId === null;
        // A solo is sung, so pitched. A section line inherits the section's flag; an
        // unknown section defaults to pitched, the common case.
        const isPitched = isSolo ? true : (section?.isPitched ?? true);

        const [demandLow, demandHigh] = resolveDemand(part, section);

        const cast = new Set(part.castMemberIds);
        const primary: CastingCandidate[] = [];
        const alsoConsider: CastingCandidate[] = [];

        for (const singer of input.singers) {
            if (cast.has(singer.memberId)) continue; // already covering this line

            const eligible =
                isSolo ||
                (part.voicePartId !== null &&
                    singer.sections.includes(part.voicePartId));
            const { fit, headroomLow, headroomHigh } = rateFit(
                singer,
                demandLow,
                demandHigh,
                isPitched,
            );
            const candidate: CastingCandidate = {
                memberId: singer.memberId,
                displayName: singer.displayName,
                fit,
                headroomLow,
                headroomHigh,
                isHomeSection:
                    part.voicePartId !== null &&
                    singer.homeSection === part.voicePartId,
            };

            if (eligible) {
                // The whole section shows, fit annotated, so the director sees a section
                // member who cannot reach the line, not just the ones who can.
                primary.push(candidate);
            } else if (fit === "comfortable" || fit === "edge") {
                // Cross-section, but their range genuinely fits: a real "also consider".
                alsoConsider.push(candidate);
            }
        }

        primary.sort(rank);
        alsoConsider.sort(rank);

        return {
            partId: part.partId,
            label: part.label,
            demandLow,
            demandHigh,
            isPitched,
            isSolo,
            primary,
            alsoConsider,
        };
    });
}

// The demanded range, from a SINGLE source: the line's own range if it names both
// bounds, else the section's nominal range if it names both, else unknown. Never
// spliced across sources. A half-open range (one bound set, which the schema permits)
// cannot anchor a fit, so it is skipped rather than borrowing the other bound from
// the section and inventing a window neither source meant (which could even invert).
function resolveDemand(
    part: PartDemand,
    section: VoicePartRange | null,
): [MidiPitch | null, MidiPitch | null] {
    if (part.rangeLow !== null && part.rangeHigh !== null)
        return [part.rangeLow, part.rangeHigh];
    if (
        section &&
        section.nominalLow !== null &&
        section.nominalHigh !== null
    ) {
        return [section.nominalLow, section.nominalHigh];
    }
    return [null, null];
}

function rateFit(
    singer: SingerProfile,
    demandLow: MidiPitch | null,
    demandHigh: MidiPitch | null,
    isPitched: boolean,
): { fit: RangeFit; headroomLow: number | null; headroomHigh: number | null } {
    if (
        !isPitched ||
        demandLow === null ||
        demandHigh === null ||
        singer.rangeLow === null ||
        singer.rangeHigh === null
    ) {
        return { fit: "unknown", headroomLow: null, headroomHigh: null };
    }
    const headroomLow = demandLow - singer.rangeLow; // >= 0: singer reaches below the demand low
    const headroomHigh = singer.rangeHigh - demandHigh; // >= 0: singer reaches above the demand high
    const worst = Math.min(headroomLow, headroomHigh);
    let fit: RangeFit;
    if (worst >= EDGE_SEMITONES) fit = "comfortable";
    else if (worst >= -EDGE_SEMITONES) fit = "edge";
    else fit = "out-of-range";
    return { fit, headroomLow, headroomHigh };
}

// Best fit first, then the most comfortable within a band, then home section, then a
// stable name/id tie-break so the same roster always ranks the same way.
function rank(a: CastingCandidate, b: CastingCandidate): number {
    if (FIT_RANK[a.fit] !== FIT_RANK[b.fit])
        return FIT_RANK[a.fit] - FIT_RANK[b.fit];
    const aWorst = worstHeadroom(a);
    const bWorst = worstHeadroom(b);
    if (aWorst !== bWorst) return bWorst - aWorst; // more headroom ranks higher
    if (a.isHomeSection !== b.isHomeSection) return a.isHomeSection ? -1 : 1;
    if (a.displayName !== b.displayName)
        return a.displayName < b.displayName ? -1 : 1;
    return a.memberId < b.memberId ? -1 : 1;
}

function worstHeadroom(c: CastingCandidate): number {
    if (c.headroomLow === null || c.headroomHigh === null) return -Infinity;
    return Math.min(c.headroomLow, c.headroomHigh);
}
