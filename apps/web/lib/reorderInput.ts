// Coerce an untrusted vocabulary-reorder payload into a clean id list.
//
// The tag, voice-part and event-type PATCH routes all take the same `{ order: string[] }`
// shape and all feed reorder_vocab, so they share one coercer instead of carrying three
// inline copies of the same check. That is the point of this module: the convention in
// CLAUDE.md is one coercer per write shape, not validation inlined in the handler.
//
// The cap is not what stops an unbounded list. The proxy already refuses a body over
// MAX_REQUEST_BYTES, which bounds a well-formed order to a few thousand ids long before it
// reaches here. What the cap adds is a stated ceiling in the same place the shape is checked,
// so the limit is a property of the input contract rather than a side effect of a transport
// setting.
//
// Rejecting rather than slicing is deliberate, and it differs from the set-shaped helpers in
// limits.ts. A truncated set still freezes something complete; a sliced order silently leaves
// the tail unsorted, and the caller has no way to tell it happened.

import { MAX_SET_IDS } from "./limits";

type Result = { ok: true; value: string[] } | { ok: false; error: string };

export function coerceReorderInput(raw: unknown): Result {
    // req.json() parses a literal `null` body successfully (it is valid JSON), so a caller's
    // catch fallback does not fire. Guard for it before reading .order.
    if (typeof raw !== "object" || raw === null)
        return { ok: false, error: "order must be an array of ids" };

    const order = (raw as { order?: unknown }).order;
    if (!Array.isArray(order) || !order.every((x) => typeof x === "string"))
        return { ok: false, error: "order must be an array of ids" };

    if (order.length > MAX_SET_IDS)
        return { ok: false, error: "order has too many ids" };

    return { ok: true, value: order as string[] };
}
