import Link from "next/link";
import { notFound } from "next/navigation";
import { clockSeconds, keyLabel, songsOf, tonicName } from "@repertoire/core";
import { DEFAULT_PADDING } from "@/lib/db";
import { loadSetlist } from "@/lib/setlist";
import { formatSeconds } from "@/lib/format";
import {
    RunningOrderSheet,
    type SheetRow,
} from "@/components/RunningOrderSheet";
import { getRepository } from "@/lib/repository";
import { resolveOrderTokens } from "@/lib/sheetOrder";
import { MAX_SET_IDS } from "@/lib/limits";

export const dynamic = "force-dynamic";

// The drafted order as a printable sheet. The starting pitch is the song's
// explicit start_pitch when set, otherwise the start key's tonic (spelled per the
// key). Breaks (intermissions) print as divider rows between the songs.
export default async function SheetPage({
    params,
    searchParams,
}: {
    params: Promise<{ ensembleId: string; setlistId: string }>;
    searchParams: Promise<{ order?: string }>;
}) {
    const { ensembleId, setlistId } = await params;
    const { order: orderParam } = await searchParams;
    const repo = getRepository();
    // The [setlistId] segment is a URL token; resolve it to the internal uuid before any data read.
    const uuid = await repo.resolvePublicId("setlist", setlistId);
    if (!uuid) notFound();

    // A performed set prints its frozen order, not a re-draft.
    const performed = await repo.getPerformedSet(uuid);
    if (performed) {
        const breakAt = new Map(
            performed.breaks.map((b) => [b.afterPosition, b]),
        );
        const rows: SheetRow[] = [];
        performed.songs.forEach((song, i) => {
            const brk = breakAt.get(i + 1);
            rows.push({
                position: i + 1,
                title: song.title,
                keyText: song.startKey ? keyLabel(song.startKey) : "—",
                pitch:
                    song.startPitch ??
                    (song.startKey ? tonicName(song.startKey) : "—"),
                duration:
                    song.durationSeconds != null
                        ? formatSeconds(song.durationSeconds)
                        : "—",
                note: performed.notes[song.id],
                segue:
                    performed.transitions[song.id] === 0 &&
                    !brk &&
                    i < performed.songs.length - 1,
            });
            if (brk) rows.push(breakSheetRow(brk.label, brk.durationSeconds));
        });
        const total =
            formatSeconds(
                clockSeconds(
                    performed.songs,
                    performed.padding,
                    new Map(Object.entries(performed.transitions)),
                    performed.breaks,
                ),
            ) +
            (performed.songs.some((s) => s.durationSeconds == null) ? "+" : ""); // a floor when a length is unset
        return (
            <main className="page">
                <Link
                    href={`/e/${ensembleId}/setlist/${setlistId}`}
                    className="back-link no-print"
                >
                    &larr; Back to set
                </Link>
                <RunningOrderSheet
                    eventName={performed.eventName}
                    setName={performed.name}
                    rows={rows}
                    total={total}
                />
                <p className="hint no-print">
                    Performed {performed.date}. The Starting Pitch column is the
                    start key&rsquo;s tonic unless a song sets its own pitch.
                </p>
            </main>
        );
    }

    const res = await loadSetlist(repo, uuid);

    if (res.status !== 200) {
        return (
            <main className="page">
                <Link href={`/e/${ensembleId}/events`} className="back-link">
                    &larr; All events
                </Link>
                <div className="page-head">
                    <h1>Could not load this setlist</h1>
                </div>
                <p className="callout shortfall">
                    {res.status}: {res.body.error}
                </p>
            </main>
        );
    }

    const { eventId, draft, notes, transitions, breaks } = res.body;
    const eventName = (await repo.getEvent(eventId))?.name ?? "Setlist";
    const setName = (await repo.getSetlistMeta(uuid))?.name ?? null;

    // Honor the director's hand-arranged order when the print link carries it (drag is
    // never persisted, so the order rides the query string). It is a permutation of the
    // drafted set — filter it to the set's songs and append any the param omitted, so the
    // sheet matches the screen without re-sequencing. No param -> the canonical drafted order.
    const songItems = songsOf(draft.set);
    const bySong = new Map(songItems.map((e) => [e.song.id, e]));
    
    // The ?order= param is a comma-separated list of song URL tokens. Map each back to its uuid,
    // scope to the set's songs, dedupe, and cap, so a hand-edited param can't inflate the sheet or
    // the clock or print a song twice. The result is a uuid list in the requested order.
    const uuidByToken = new Map(
        res.body.catalog.map((c) => [c.publicId, c.id]),
    );
    const inSet = new Set(bySong.keys());
    const requested = resolveOrderTokens(
        orderParam,
        uuidByToken,
        inSet,
        MAX_SET_IDS,
    );
    const hasOrder = requested.length > 0;
    const ordered = hasOrder
        ? [
              ...requested.map((id) => bySong.get(id)!),
              ...songItems.filter((e) => !requested.includes(e.song.id)),
          ]
        : songItems;

    // Breaks are ordinal — they sit at their slot over whatever song order is on the page.
    const breakAt = new Map(breaks.map((b) => [b.afterPosition, b]));
    const songOverrides = new Map(
        await Promise.all(
            ordered.map(
                async (entry) =>
                    [entry.song.id, await repo.getSong(entry.song.id)] as const,
            ),
        ),
    );
    const rows: SheetRow[] = [];
    ordered.forEach((entry, i) => {
        const startKey = entry.song.startKey;
        const override = songOverrides.get(entry.song.id)?.startPitch ?? null;
        const brk = breakAt.get(i + 1);
        rows.push({
            position: i + 1,
            title: entry.song.title,
            keyText: startKey ? keyLabel(startKey) : "—",
            pitch: override ?? (startKey ? tonicName(startKey) : "—"),
            duration:
                entry.song.durationSeconds != null
                    ? formatSeconds(entry.song.durationSeconds)
                    : "—",
            note: notes[entry.song.id],
            segue:
                transitions[entry.song.id] === 0 &&
                !brk &&
                i < ordered.length - 1,
        });
        if (brk) rows.push(breakSheetRow(brk.label, brk.durationSeconds));
    });

    // Recompute the clock for the order on the page — a hand-arrange can move a segued song
    // or a break boundary — else fall back to core's drafted-order total.
    const padding =
        (await repo.getEvent(eventId))?.resolved.padding ?? DEFAULT_PADDING;
    const unsetLength = ordered.some((e) => e.song.durationSeconds == null); // a floor when a length is unset
    const total =
        (hasOrder
            ? formatSeconds(
                  clockSeconds(
                      ordered.map((e) => e.song),
                      padding,
                      new Map(Object.entries(transitions)),
                      breaks,
                  ),
              )
            : formatSeconds(draft.totalSeconds)) + (unsetLength ? "+" : "");

    return (
        <main className="page">
            <Link
                href={`/e/${ensembleId}/setlist/${setlistId}`}
                className="back-link no-print"
            >
                &larr; Back to draft
            </Link>
            <RunningOrderSheet
                eventName={eventName}
                setName={setName}
                rows={rows}
                total={total}
            />
            <p className="hint no-print">
                The Starting Pitch column is the start key&rsquo;s tonic unless
                a song sets its own pitch.
            </p>
        </main>
    );
}

// A divider row for an intermission. Position 0 marks it as a break; the columns are blank.
function breakSheetRow(label: string, durationSeconds: number): SheetRow {
    return {
        position: 0,
        title: "",
        keyText: "",
        pitch: "",
        duration: "",
        breakRow: { label, duration: formatSeconds(durationSeconds) },
    };
}
