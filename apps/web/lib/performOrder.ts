// The frozen running order for a performed set, resolved from the client's sent order and the
// server-built set membership. Split out of the perform route so the reconciliation is unit-testable.
//
// Rules: keep the client's order, scoped to songs actually in the set and deduped (the supabase
// perform_setlist RPC dedupes with `group by song_id`; the mock does not, so without this the two
// adapters would freeze different records from one request); then append any set song the client
// omitted, in set order, so the frozen record is always complete. Empty result => the route refuses
// (nothing to perform).
export function resolvePerformOrder(
    sent: string[],
    setIds: string[],
): string[] {
    const inSet = new Set(setIds);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of sent) {
        if (inSet.has(id) && !seen.has(id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    for (const id of setIds) {
        if (!seen.has(id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    return ordered;
}
