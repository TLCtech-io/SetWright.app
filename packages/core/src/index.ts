// Public surface of @repertoire/core: the drafter funnel, the sequence stage,
// the pitch and key geometry, and the result types each returns.

export * from "./types.js";
export {
    midi,
    noteName,
    tonicPitchClass,
    tonicPosition,
    circleDistance,
    isRelativePair,
    keyDirection,
    keyLabel,
    tonicName,
} from "./pitch.js";

export {
    draftSet,
    draftSetWithChase,
    isSongItem,
    isBreakItem,
    songsOf,
    breaksOf,
    interleaveBreaks,
    normalizeBreaks,
} from "./drafter/index.js";
export type {
    DraftResult,
    DraftWithChase,
    SetEntry,
    SetItem,
    SongItem,
    BreakItem,
} from "./drafter/index.js";

export { computeChase } from "./drafter/chase.js";
export type { ChaseCandidate, ChaseTarget } from "./drafter/chase.js";

export { suggestCasting } from "./casting/suggest.js";
export type {
    CastingSuggestionInput,
    SingerProfile,
    VoicePartRange,
    PartDemand,
    RangeFit,
    CastingCandidate,
    PartSuggestion,
} from "./casting/suggest.js";

export {
    sequence,
    scoreOrder,
    seamsFor,
    keyTransitionCost,
    DEFAULT_SEQUENCE_CONFIG,
    DEFAULT_KEY_COST,
} from "./drafter/sequence.js";
export type {
    Seam,
    SeamFlag,
    SequenceConfig,
    SequenceWeights,
    SequenceInput,
    SequenceResult,
    KeyCostConfig,
} from "./drafter/sequence.js";

export { checkFeasibility } from "./drafter/feasibility.js";
export type {
    FeasibilityInput,
    FeasibilityResult,
    SongIndex,
} from "./drafter/feasibility.js";

export { checkReadiness } from "./drafter/readiness.js";
export type { ReadinessInput, ReadinessResult } from "./drafter/readiness.js";

export { checkContext } from "./drafter/context.js";
export type { ContextResult } from "./drafter/context.js";

export {
    stageTime,
    selectToLength,
    clockSeconds,
    segmentOrder,
} from "./drafter/selection.js";
export type { Scored } from "./drafter/selection.js";

export type { Drop } from "./drafter/diagnostics.js";

export { groupBy, indexBySong, indexByPart } from "./group.js";
