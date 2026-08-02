import { useEffect, useState } from "react";

// Client-side pagination over an already-filtered list. The caller passes the full filtered array
// (a single ensemble's book is small enough to hold in the browser, same as the list itself) plus a
// resetKey — the serialized search/sort/filter state. When that key changes the view returns to page
// 1, so narrowing the list never strands the reader on a now-empty page. The returned page is also
// clamped into range every render as a backstop. Shared by the director repertoire and the member
// repertoire browser.

export interface Pagination<T> {
    page: number; // 1-based, clamped to [1, pageCount]
    pageSize: number;
    pageCount: number; // total pages, at least 1
    pageItems: T[]; // the slice for the current page
    setPage: (p: number) => void;
    setPageSize: (n: number) => void;
    sizes: number[]; // the offered page-size options
    from: number; // 1-based index of the first item shown (0 when empty)
    to: number; // 1-based index of the last item shown
    total: number; // items.length
}

export function usePagination<T>(
    items: T[],
    opts?: { sizes?: number[]; initialSize?: number; resetKey?: string },
): Pagination<T> {
    const sizes = opts?.sizes ?? [10, 25, 50];
    const [pageSize, setPageSize] = useState(
        opts?.initialSize ?? sizes[Math.min(1, sizes.length - 1)]!,
    );
    const [page, setPage] = useState(1);

    // Return to the first page whenever the filtered set changes (resetKey) or the size changes, so a
    // narrowing filter or a smaller page size never leaves the reader past the end.
    useEffect(() => {
        setPage(1);
    }, [opts?.resetKey, pageSize]);

    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), pageCount);
    const start = (safePage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    return {
        page: safePage,
        pageSize,
        pageCount,
        pageItems,
        setPage,
        setPageSize,
        sizes,
        from: total === 0 ? 0 : start + 1,
        to: Math.min(start + pageSize, total),
        total,
    };
}
