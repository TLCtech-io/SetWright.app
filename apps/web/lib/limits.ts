// Cardinality caps for request-supplied id lists (pins, hand-arranged orders).
//
// These arrive over the wire from the director's own client, so they are not a remote-attacker
// surface — but an unbounded list (a buggy or hostile same-tenant client) would still hand the
// drafter/sequencer or the perform freeze an absurd amount of work. A real set is a few dozen
// songs; this cap sits far above that, so legitimate use is never touched. Lists are sliced, not
// rejected: the extra ids are pathological noise, and the perform route re-appends any genuine
// set song the cap dropped, so a truncated order still freezes complete.

/** Most ids any one set-shaped list (pins, an order) can carry. Far above a real set. */
export const MAX_SET_IDS = 512;

/** Largest accepted request body, in bytes. Every real payload (a song, a roster, a 512-id list)
 *  is a few KB to tens of KB; 256KB is generous headroom while still refusing a memory/CPU blowup
 *  from a multi-megabyte body. Enforced by Content-Length at the proxy. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Most entries any one untrusted form array (castings, parts, tags, sections, availability) is
 *  processed with. The body cap bounds the gross case; this bounds per-array iteration as defense
 *  in depth, far above any real form. */
export const MAX_FORM_ITEMS = 1024;

/** Filter an unknown value to a string-id list, capped to MAX_SET_IDS. */
export function coerceIdList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
        if (typeof x === "string") out.push(x);
        if (out.length >= MAX_SET_IDS) break;
    }
    return out;
}
