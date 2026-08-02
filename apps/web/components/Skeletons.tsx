// Shimmer placeholders for route loading.tsx files. Pure presentational server components (no
// interactivity, no data). Each block is aria-hidden and carries no meaning; the loading.tsx that
// composes them wraps the page in a role="status" region so assistive tech hears "Loading" once.
// Skeletons deliberately reuse the real pages' container classes (page-head, hub-stats, songs-table,
// ...) so the shimmer occupies the same space and the swap to real content shifts little.

import type { CSSProperties } from "react";

// One shimmer block. Height defaults to a text line; pass w/h/r to shape it.
export function Sk({
    w,
    h = 14,
    r,
    style,
}: {
    w?: number | string;
    h?: number | string;
    r?: number;
    style?: CSSProperties;
}) {
    return (
        <div
            className="skeleton"
            aria-hidden="true"
            style={{ width: w, height: h, borderRadius: r, ...style }}
        />
    );
}

// The page title + subtitle block every page opens with.
export function SkPageHead({ action = false }: { action?: boolean }) {
    return (
        <div className="page-head">
            <div>
                <Sk w={210} h={30} />
                <Sk
                    w={300}
                    h={14}
                    style={{ marginTop: 12, maxWidth: "70vw" }}
                />
            </div>
            {action && <Sk w={110} h={38} r={9} />}
        </div>
    );
}

// A stack of rows, e.g. a table body or a list. `cols` widths shape each row's cells.
export function SkRows({
    rows = 8,
    cols = ["40%", "12%", "12%", "10%", "16%"],
}: {
    rows?: number;
    cols?: string[];
}) {
    return (
        <div className="skeleton-rows" aria-hidden="true">
            {Array.from({ length: rows }).map((_, i) => (
                <div className="skeleton-row" key={i}>
                    {cols.map((w, j) => (
                        <Sk key={j} w={w} h={14} />
                    ))}
                </div>
            ))}
        </div>
    );
}

// The back-link that detail, form, and report pages open with, above the page-head.
export function SkBackLink() {
    return <Sk w={90} h={13} style={{ display: "block", marginBottom: 14 }} />;
}

// The search + sort/filter toolbar (songs-toolbar), with an optional filter-chip row.
export function SkToolbar({
    selects = 2,
    chips = 0,
}: {
    selects?: number;
    chips?: number;
}) {
    return (
        <div className="songs-toolbar">
            <Sk w="100%" h={40} r={9} style={{ maxWidth: 360 }} />
            <div className="songs-controls">
                {Array.from({ length: selects }).map((_, i) => (
                    <Sk key={i} w={i === 0 ? 130 : 110} h={38} r={9} />
                ))}
            </div>
            {chips > 0 && (
                <div className="filter-chips">
                    {Array.from({ length: chips }).map((_, i) => (
                        <Sk key={i} w={64} h={28} r={14} />
                    ))}
                </div>
            )}
        </div>
    );
}

// The result-count line that sits under a toolbar.
export function SkCount() {
    return (
        <Sk
            w={120}
            h={11}
            style={{ display: "block", margin: "4px 2px 12px" }}
        />
    );
}

// One form-card section: a label over field rows, with an optional trailing chip row (a tag picker).
// The card's own flex gap spaces the children, so no per-row margins are needed.
export function SkFormCard({
    fields = 2,
    chips = 0,
}: {
    fields?: number;
    chips?: number;
}) {
    return (
        <section className="form-card">
            <Sk w={70} h={12} />
            {Array.from({ length: fields }).map((_, i) => (
                <Sk key={i} w="100%" h={40} r={9} />
            ))}
            {chips > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Array.from({ length: chips }).map((_, i) => (
                        <Sk key={i} w={80} h={30} r={999} />
                    ))}
                </div>
            )}
        </section>
    );
}

// The roster card-grid: section cards, each a header over avatar/name/range rows. `cards` gives the
// row count per card (varied so it does not read as uniform). Reuses the real roster-* classes.
export function SkRosterGrid({ cards = [4, 3, 5] }: { cards?: number[] }) {
    return (
        <div className="roster-grid">
            {cards.map((rows, c) => (
                <section className="roster-card" key={c}>
                    <div className="roster-card-head">
                        <Sk w={90} h={14} />
                        <Sk w={60} h={11} />
                    </div>
                    <div className="roster-rows">
                        {Array.from({ length: rows }).map((_, i) => (
                            <div className="roster-row" key={i}>
                                <Sk w={36} h={36} r={18} />
                                <div className="roster-main">
                                    <Sk w={160} h={14} />
                                    <Sk
                                        w={120}
                                        h={11}
                                        style={{ marginTop: 8 }}
                                    />
                                </div>
                                <Sk w={70} h={12} />
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

// A stack of menu cards (the insights index, the member home): each a head row (title + stat pill)
// over a two-line description. Reuses the real cards/card/card-head classes.
export function SkCardGrid({ count = 6 }: { count?: number }) {
    return (
        <div className="cards">
            {Array.from({ length: count }).map((_, i) => (
                <div className="card" key={i}>
                    <div className="card-head">
                        <Sk w={130} h={14} />
                        <Sk w={70} h={20} r={8} />
                    </div>
                    <Sk w="90%" h={11} style={{ marginTop: 10 }} />
                    <Sk w="65%" h={11} style={{ marginTop: 6 }} />
                </div>
            ))}
        </div>
    );
}

// The setlist workspace shape shared by the draft, playground, and setlist routes: back-link, head,
// full-width timing bar, arc band, then the two-column set-main (a stack of song rows) + set-rail.
// `action` adds head buttons; `library` swaps the rail's panel for the playground's add-songs list.
export function SkSetlistWorkspace({
    action = false,
    library = false,
}: {
    action?: boolean;
    library?: boolean;
}) {
    return (
        <>
            <SkBackLink />
            <SkPageHead action={action} />
            <Sk
                w="100%"
                h={44}
                r={10}
                style={{ display: "block", marginTop: 16 }}
            />
            <Sk
                w="100%"
                h={72}
                r={10}
                style={{ display: "block", marginTop: 16 }}
            />
            <div className="setlist-workspace">
                <div className="set-main">
                    <Sk w={90} h={20} />
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            marginTop: 12,
                        }}
                    >
                        {Array.from({ length: 6 }).map((_, i) => (
                            <Sk key={i} w="100%" h={56} r={10} />
                        ))}
                    </div>
                </div>
                <aside className="set-rail">
                    <div className="panel">
                        {library ? (
                            <>
                                <Sk w={80} h={16} />
                                <Sk
                                    w="100%"
                                    h={38}
                                    r={9}
                                    style={{ marginTop: 12 }}
                                />
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <Sk
                                        key={i}
                                        w="100%"
                                        h={40}
                                        r={8}
                                        style={{ marginTop: 8 }}
                                    />
                                ))}
                            </>
                        ) : (
                            <>
                                <Sk w="60%" h={16} />
                                <Sk
                                    w="100%"
                                    h={80}
                                    r={8}
                                    style={{ marginTop: 12 }}
                                />
                            </>
                        )}
                    </div>
                </aside>
            </div>
        </>
    );
}
