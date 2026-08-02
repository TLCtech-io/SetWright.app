"use client";

import type { Pagination as PaginationState } from "@/lib/usePagination";

// The pagination footer: a page-size selector [10, 25, 50], the current range, and prev/next. Pure
// presentation over the usePagination state; both the director repertoire and the member browser
// render it. Buttons never disable the focused control mid-interaction by yanking focus — prev/next
// disable only at the ends, which is expected. The range line is a polite live region so a screen
// reader hears the page change.
export function Pagination<T>({
    state,
    unit,
}: {
    state: PaginationState<T>;
    unit: string;
}) {
    const {
        page,
        pageSize,
        pageCount,
        setPage,
        setPageSize,
        sizes,
        from,
        to,
        total,
    } = state;

    return (
        <div className="pagination">
            <label className="pagination-size">
                <span className="pagination-size-label">Show</span>
                <select
                    className="songs-select"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    aria-label={`Show ${unit} per page`}
                >
                    {sizes.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </select>
            </label>

            <span
                className="pagination-range"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {from}&ndash;{to} of {total}
            </span>

            <div className="pagination-nav">
                <button
                    type="button"
                    className="pagination-btn"
                    onClick={() => setPage(page - 1)}
                    disabled={page <= 1}
                    aria-label="Previous page"
                >
                    &lsaquo; Prev
                </button>
                <span className="pagination-page">
                    Page {page} of {pageCount}
                </span>
                <button
                    type="button"
                    className="pagination-btn"
                    onClick={() => setPage(page + 1)}
                    disabled={page >= pageCount}
                    aria-label="Next page"
                >
                    Next &rsaquo;
                </button>
            </div>
        </div>
    );
}
