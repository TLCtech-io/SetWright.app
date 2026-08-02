// PostgREST caps a single select at its max-rows setting (1000 by default) and silently truncates a
// larger result. Page a range-fetch to completion: call fetchPage for successive [from, to] windows
// until a short page. fetchPage returns the already-unwrapped rows for its window. Split out here
// (pure, no supabase dependency) so the paging loop is unit-testable; selectAll in the adapter wraps
// it with the query builder + unwrap and a stable total order so pages never overlap or skip.
export const PAGE_SIZE = 1000;

export async function pageAll<T>(
    fetchPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const rows = await fetchPage(from, from + PAGE_SIZE - 1);
        out.push(...rows);
        if (rows.length < PAGE_SIZE) break;
    }
    return out;
}
