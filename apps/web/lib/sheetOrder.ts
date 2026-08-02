// Resolve a print sheet's ?order= query param to internal song uuids, in the requested order.
// Extracted from the sheet page so the token-to-uuid mapping, dedupe, drop-unknown, and cap are
// pure and unit-tested.
//
// Drag order is never persisted, so it rides the query string as a comma-separated list of song
// public_id tokens. A hand-edited param must not print a song twice (dedupe on the resolved uuid)
// or inflate the sheet and its clock (cap the kept count), and any token that is not a song in
// this set is dropped. The order of the first appearance of each valid token is preserved.

export function resolveOrderTokens(
    orderParam: string | null | undefined,
    uuidByToken: Map<string, string>,
    inSet: Set<string>,
    cap: number,
): string[] {
    if (!orderParam) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of orderParam.split(",")) {
        const uuid = uuidByToken.get(raw.trim());
        if (uuid === undefined || !inSet.has(uuid) || seen.has(uuid)) continue;
        seen.add(uuid);
        out.push(uuid);
        if (out.length >= cap) break;
    }
    return out;
}
