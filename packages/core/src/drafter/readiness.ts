// Stage 2: readiness (soft gate, tunable, mode-aware).
//
// Two jobs. First, hard filters: drop charts below the allowed readiness
// floor, and when the event is off-book only, drop on-book charts. Second, a
// score: prefer performance-ready, and treat a shaky lead on a featured part
// as a soft strike against leaning on the song.

import type {
    AssessedReadiness,
    Casting,
    Confidence,
    ID,
    Part,
    ResolvedEvent,
    Song,
} from "../types.js";

const READINESS_RANK: Record<AssessedReadiness, number> = {
    "performance-ready": 3,
    "needs-polish": 2,
    learning: 1,
    dormant: 0,
};

// The readiness rank on its own, independent of the floor gate. checkReadiness zeroes its
// score for a song below the floor; a preferred (prep) song bypasses that gate but still
// needs its true rank so the preferred tier orders most-ready first when the budget is tight.
export function readinessRank(song: Song): number {
    return READINESS_RANK[song.assessedReadiness];
}

const CONFIDENCE_PENALTY: Record<Confidence, number> = {
    solid: 0,
    shaky: 1,
    learning: 2,
};

// Unreported confidence carries no strike: null reads as solid-equivalent.
function confidencePenalty(c: Confidence | null): number {
    return c ? CONFIDENCE_PENALTY[c] : 0;
}

// The confidence the readiness score leans on: the director's own read wins when
// set, else the member's self-report. Members self-report late (or not at all), so
// the director's assessment, when present, is the more reliable signal. Both null =
// no strike, so an unassessed, unreported cover reads as solid-equivalent, unchanged.
function effectiveConfidence(c: Casting): Confidence | null {
    return c.directorAssessed ?? c.confidence;
}

export interface ReadinessInput {
    song: Song;
    parts: Part[];
    castingsByPart: Map<ID, Casting[]>;
    availableMemberIds: Set<ID>;
    event: ResolvedEvent;
    readinessFloor: AssessedReadiness[];
}

export interface ReadinessResult {
    eligible: boolean;
    reason?: "below-readiness-floor" | "on-book-not-allowed";
    readinessScore: number;
    soloConfidencePenalty: number;
}

export function checkReadiness(input: ReadinessInput): ReadinessResult {
    const {
        song,
        parts,
        castingsByPart,
        availableMemberIds,
        event,
        readinessFloor,
    } = input;

    // Mode-aware hard filter.
    if (!event.allowsOnBook && song.bookStatus === "on-book") {
        return {
            eligible: false,
            reason: "on-book-not-allowed",
            readinessScore: 0,
            soloConfidencePenalty: 0,
        };
    }

    if (!readinessFloor.includes(song.assessedReadiness)) {
        return {
            eligible: false,
            reason: "below-readiness-floor",
            readinessScore: 0,
            soloConfidencePenalty: 0,
        };
    }

    // Soloist confidence. A featured part is a required single-seat line.
    // The lead is the primary if available, else the most confident cover.
    let penalty = 0;
    const featured = parts.filter((p) => p.isRequired && p.countNeeded === 1);
    for (const p of featured) {
        const cast = (castingsByPart.get(p.id) ?? []).filter((c) =>
            availableMemberIds.has(c.memberId),
        );
        if (cast.length === 0) continue; // feasibility owns missing coverage
        penalty += confidencePenalty(effectiveConfidence(pickLead(cast)));
    }

    return {
        eligible: true,
        readinessScore: READINESS_RANK[song.assessedReadiness],
        soloConfidencePenalty: penalty,
    };
}

function pickLead(cast: Casting[]): Casting {
    const primary = cast.find((c) => c.isPrimary);
    if (primary) return primary;
    return [...cast].sort(
        (a, b) =>
            confidencePenalty(effectiveConfidence(a)) -
            confidencePenalty(effectiveConfidence(b)),
    )[0]!;
}
