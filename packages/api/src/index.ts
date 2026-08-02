// Public surface of @repertoire/api: the framework-agnostic endpoint, the
// mapper, and the Supabase adapter for the hydration source.

export {
    draftSetForEvent,
    draftSetForSetlist,
    seamsForOrder,
    sequenceForOrder,
} from "./endpoint.js";
export { toDraftInput } from "./mapper.js";
export { supabaseHydrationSource } from "./supabase.js";
export type { SupabaseRpcClient } from "./supabase.js";
export type {
    HydrationPayload,
    HydrationSource,
    LocksSource,
    SetlistLocks,
    SetlistSource,
    DraftSetResponse,
    SeamsResponse,
    ArrangeResponse,
} from "./types.js";
