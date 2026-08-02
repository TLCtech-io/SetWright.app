import Link from "next/link";
import { songsOf } from "@repertoire/core";
import type { DraftWithChase, Seam } from "@repertoire/core";
import { getRepository } from "@/lib/repository";
import { loadSetlist } from "@/lib/setlist";
import { busFactor } from "@/lib/insights";
import { buildCoverage } from "@/lib/coverage";
import { behindSchedule } from "@/lib/prep";
import {
    formatSeconds,
    formatEventDate,
    formatKeyRange,
    seamFlagLabel,
    summarizeSeamFlags,
    todayInTz,
} from "@/lib/format";
import { IntensityDots } from "@/components/IntensityDots";

// Reads mutable db state + drafts the next event live, so it renders per request.
export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
    Math.round((Date.parse(b) - Date.parse(a)) / DAY);

// The director's home: the next event front-and-centre with a live fill verdict + energy
// arc, then four at-a-glance health stats (availability, repertoire readiness, coverage,
// recency). The full events table lives in its own Events section.
export default async function DashboardPage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const base = `/e/${ensembleId}`;
    const repo = getRepository();
    const [events, roster, songs] = await Promise.all([
        repo.listEvents(),
        repo.listRoster(),
        repo.listSongs(),
    ]);

    // Active singing pool — matches the drafter's own pool (hydratePayload), so RSVP
    // denominators and availability counts line up with what the draft actually sees.
    const singers = roster.filter((m) => m.singing && m.status === "active");
    const singerIds = new Set(singers.map((m) => m.id));
    const pool = singers.map((m) => ({ id: m.id, displayName: m.displayName }));

    // Day boundary in the ensemble's timezone, matching the SQL's current_date-at-tz —
    // UTC would flip "today" hours early for a US-evening director. One settings read also
    // names the ensemble for the onboarding rail below.
    const settings = await repo.getEnsembleSettings();
    const today = todayInTz(settings.timezone);

    // Next event: soonest upcoming by date, else most recent, else the first.
    const dated = events
        .filter((e) => e.resolved.eventDate)
        .sort((a, b) =>
            a.resolved.eventDate!.localeCompare(b.resolved.eventDate!),
        );
    const next =
        dated.find((e) => e.resolved.eventDate! >= today) ??
        dated[dated.length - 1] ??
        events[0];

    // Active songs only (mirror the drafter pool), bucketed by assessed readiness.
    const activeSongs = songs.filter((s) => s.status === "active");
    const readiness = {
        ready: activeSongs.filter(
            (s) => s.assessedReadiness === "performance-ready",
        ).length,
        polishing: activeSongs.filter(
            (s) => s.assessedReadiness === "needs-polish",
        ).length,
        learning: activeSongs.filter((s) => s.assessedReadiness === "learning")
            .length,
        dormant: activeSongs.filter((s) => s.assessedReadiness === "dormant")
            .length,
    };

    // Coverage: ensemble-wide single-points-of-failure (a part only one available singer covers).
    // One batched read of the book's parts + castings, regrouped per song, instead of a query per song.
    const coverage = await buildCoverage(repo, activeSongs);
    const coverageRisk = busFactor(coverage, pool);
    const fragile = coverageRisk.length;

    // Behind schedule: songs a gig wants ready that are not performance-ready or fully
    // cast, soonest deadline first. Reuses the coverage busFactor above (undercast = can't be
    // cast even with everyone), plus a prep-target read per upcoming gig.
    const notReady = new Set(
        activeSongs
            .filter((s) => s.assessedReadiness !== "performance-ready")
            .map((s) => s.id),
    );
    const undercast = new Set(
        coverageRisk.filter((r) => r.kind === "undercast").map((r) => r.songId),
    );
    // Split the flat "fragile" total into its two severities so the coverage card and the "Needs you"
    // row can name the actionable count (uncastable even with everyone in) instead of a total that,
    // when most of the book has one thin part, reads as "everything is fragile".
    const uncastable = undercast.size;
    const oneAway = fragile - uncastable;
    const coverageSub =
        fragile === 0
            ? "every part is double-covered"
            : uncastable === 0
              ? "parts only one singer covers"
              : oneAway === 0
                ? `${uncastable} uncastable`
                : `${uncastable} uncastable, ${oneAway} one absence away`;
    const titleById = new Map(activeSongs.map((s) => [s.id, s.title]));
    const upcomingGigs = events.filter(
        (e) => !!e.resolved.eventDate && e.resolved.eventDate >= today,
    );
    const gigTargets = await Promise.all(
        upcomingGigs.map(async (e) => ({
            id: e.id,
            name: e.name,
            date: e.resolved.eventDate!,
            targetSongIds: await repo.getPrepTargets(e.id),
        })),
    );
    const behind = behindSchedule({
        gigs: gigTargets.filter((g) => g.targetSongIds.length > 0),
        titleById,
        notReady,
        undercast,
        today,
    });

    // Recency: never performed, or not in 90+ days.
    const stale = activeSongs.filter(
        (s) => !s.lastPerformed || daysBetween(s.lastPerformed, today) > 90,
    ).length;
    // Rehearsal recency: performance-ready songs gone cold (not rehearsed in 90+ days). A
    // never-rehearsed song carries no signal (null = unknown), matching the drafter's staleness.
    const goneCold = activeSongs.filter(
        (s) =>
            s.assessedReadiness === "performance-ready" &&
            !!s.lastRehearsed &&
            daysBetween(s.lastRehearsed, today) > 90,
    ).length;

    // Availability breakdown for the next event, scoped to the active pool.
    const nextAvail = next
        ? next.availability.filter((a) => singerIds.has(a.memberId))
        : [];
    const avIn = nextAvail.filter((a) => a.status === "in").length;
    const avOut = nextAvail.filter((a) => a.status === "out").length;
    const avMaybe = nextAvail.filter((a) => a.status === "tentative").length;
    const avPending = Math.max(0, singers.length - nextAvail.length);

    // The hero fill, the energy arc, and the Set-in-progress panel all read from ONE source:
    // the saved setlist via loadSetlist. That applies the director's pins/reorder/transitions/
    // breaks (and returns a performed set's frozen order), so the dashboard preview matches
    // exactly what "Continue draft" / "Open the set" opens — not a throwaway re-draft.
    const nextSetlists = next ? await repo.listEventSetlists(next.id) : [];
    const nextSetlist = nextSetlists[0];
    let draft: DraftWithChase | null = null;
    if (next && nextSetlist) {
        try {
            const res = await loadSetlist(repo, nextSetlist.id);
            if (res.status === 200) draft = res.body.draft;
        } catch {
            /* hero + panel fall back to the plain target below */
        }
    }
    const fill =
        draft && draft.targetSeconds != null
            ? {
                  filled: draft.totalSeconds,
                  target: draft.targetSeconds,
                  thin: draft.shortfall != null,
                  arc: songsOf(draft.set).map((i) => i.song.intensity),
              }
            : null;
    const draftHref = nextSetlist
        ? `${base}/setlist/${nextSetlist.publicId}`
        : next
          ? `${base}/draft/${next.publicId}`
          : base;
    // Set name + status ("Service set · draft") — pulled out of the hero per design; kept for review.
    // const draftLabel = nextSetlist ? `${nextSetlist.name ?? 'Draft set'} · ${nextSetlist.status}` : null;

    // Set-in-progress rows: the drafted songs in order, with the seam (if flagged) that
    // leaves each one. Seams are keyed by the song they leave (fromId).
    const setSongs = draft ? songsOf(draft.set) : [];
    const seamByFrom = new Map<string, Seam>(
        (draft?.seams ?? []).map((s) => [s.fromId, s]),
    );
    // Collapse a flag that fires across most transitions into one caption, so the overview does not
    // repeat the same warning between every pair. The detailed draft view keeps the per-seam flags.
    const seamSummary = summarizeSeamFlags(draft?.seams ?? []);
    const fillDeltaMin = fill
        ? Math.round((fill.target - fill.filled) / 60)
        : 0;

    // The panel-foot verdict, using the SAME "thin" rule as the hero (fill.thin mirrors the
    // drafter's shortfall) so the two never contradict on a short target where the minute
    // delta rounds to 0 but the set is still under the fill threshold.
    let footVerdict: { klass: string; text: string } | null = null;
    if (fill) {
        const under = fill.thin || fillDeltaMin > 0;
        const over = !under && fillDeltaMin < 0;
        footVerdict = {
            klass: over ? "over" : under ? "under" : "ok",
            text: under
                ? `${Math.max(1, fillDeltaMin)} min under target`
                : over
                  ? `${Math.abs(fillDeltaMin)} min over target`
                  : "on target",
        };
    }

    // "Needs you" — the director's action queue, only surfacing rows with something to act on.
    const unconfirmed = avPending + avMaybe; // haven't firmly committed to the next event
    const learning = readiness.learning;
    const needs: {
        key: string;
        tone: string;
        line1: string;
        line2: string;
        action: string;
        href: string;
    }[] = [];
    if (next && unconfirmed > 0) {
        needs.push({
            key: "avail",
            tone: "clay",
            line1: `${unconfirmed} ${unconfirmed === 1 ? "singer hasn’t" : "singers haven’t"} confirmed`,
            line2: `availability for ${next.name}`,
            action: "Nudge",
            href: `${base}/events/${next.publicId}`,
        });
    }
    if (fragile > 0) {
        needs.push({
            key: "cover",
            tone: "amber",
            line1: `${fragile} fragile ${fragile === 1 ? "song" : "songs"}`,
            line2: coverageSub,
            action: "Review",
            href: `${base}/insights/coverage`,
        });
    }
    if (behind.length > 0) {
        const soonest = behind[0]!; // rows are sorted by days left
        needs.push({
            key: "behind",
            tone: "clay",
            line1: `${behind.length} ${behind.length === 1 ? "song" : "songs"} behind schedule`,
            line2:
                soonest.daysLeft === 0
                    ? `${soonest.title} due today for ${soonest.gigName}`
                    : `soonest due in ${soonest.daysLeft} day${soonest.daysLeft === 1 ? "" : "s"} for ${soonest.gigName}`,
            action: "Review",
            href: `${base}/insights/behind-schedule`,
        });
    }
    if (learning > 0) {
        needs.push({
            key: "learn",
            tone: "teal",
            line1: `${learning} ${learning === 1 ? "song" : "songs"} still learning`,
            line2: "not performance-ready yet",
            action: "Review",
            href: `${base}/insights/learning`,
        });
    }

    // The hero fill verdict: signed minute delta + thin / on-target / over.
    let verdict: { klass: string; delta: string; text: string } | null = null;
    if (fill) {
        const deltaMin = Math.round((fill.target - fill.filled) / 60);
        if (fill.thin || deltaMin >= 1) {
            const short = Math.max(1, deltaMin);
            verdict = {
                klass: "",
                delta: `−${short} MIN`,
                text: "thin. Add another song to hit target.",
            };
        } else if (deltaMin <= -1) {
            verdict = {
                klass: "over",
                delta: `+${Math.abs(deltaMin)} MIN`,
                text: "over target. Trim a song or tighten segues.",
            };
        } else {
            verdict = {
                klass: "ok",
                delta: "ON TARGET",
                text: "set length is on target.",
            };
        }
    }

    // The hero energy-arc glyph: one bar per drafted song, height ∝ intensity (1–5), the
    // peak song in coral, unrated songs a short faint bar. null when there's no drafted set.
    const BAR_W = 7;
    const BAR_GAP = 3;
    const ARC_H = 34;
    let heroArc: { x: number; y: number; h: number; fill: string }[] | null =
        null;
    let heroArcW = 0;
    if (fill && fill.arc.length > 0) {
        const bars = fill.arc.slice(0, 16);
        const rated = bars.map((v) => (v == null ? 0 : v));
        const peak = Math.max(...rated);
        const peakIdx = peak > 0 ? rated.indexOf(peak) : -1;
        heroArcW = bars.length * (BAR_W + BAR_GAP) - BAR_GAP;
        heroArc = bars.map((v, i) => {
            const clamped = v == null ? null : Math.min(5, Math.max(1, v));
            const h = clamped == null ? 5 : Math.round(6 + (clamped / 5) * 28);
            return {
                x: i * (BAR_W + BAR_GAP),
                y: ARC_H - h,
                h,
                fill:
                    i === peakIdx
                        ? "var(--clay)"
                        : clamped == null
                          ? "var(--faint)"
                          : "var(--text)",
            };
        });
    }

    const heroMeta = next
        ? [formatEventDate(next.resolved.eventDate), next.venue]
              .filter(Boolean)
              .join(" · ")
        : "";

    // Day one is a wall of zeros. When the book and events are both empty, stand a three-step
    // setup rail in the hero slot (the "Next event" hero omits itself with no events anyway).
    // Step one fills teal once a second member joins; the book and event steps follow.
    const isNewEnsemble = activeSongs.length === 0 && events.length === 0;
    const hasOtherMembers =
        roster.filter((m) => m.status === "active").length > 1;

    return (
        <main className="page hub">
            {isNewEnsemble && (
                <section className="setup-rail">
                    <span className="eyebrow">Welcome</span>
                    <h1 className="setup-title">
                        Let&rsquo;s set up {settings.name}
                    </h1>
                    <p className="setup-body">
                        Three steps to your first set: add your singers, build
                        your book, then create an event. Start with the book.
                    </p>
                    <ol className="setup-steps">
                        <li
                            className={`setup-step${hasOtherMembers ? " done" : ""}`}
                        >
                            <span className="setup-step-num">1</span>
                            <div className="setup-step-text">
                                <span className="setup-step-title">
                                    Add singers
                                </span>
                                <span className="setup-step-sub">
                                    Invite them by email or add them by hand.
                                </span>
                            </div>
                            <Link
                                href={`${base}/roster/new`}
                                className="setup-step-cta"
                            >
                                {hasOtherMembers
                                    ? "Add more →"
                                    : "Add singer →"}
                            </Link>
                        </li>
                        <li className="setup-step">
                            <span className="setup-step-num">2</span>
                            <div className="setup-step-text">
                                <span className="setup-step-title">
                                    Build your book
                                </span>
                                <span className="setup-step-sub">
                                    Songs with their key, tempo, and length.
                                </span>
                            </div>
                            <Link
                                href={`${base}/repertoire/new`}
                                className="setup-step-cta primary"
                            >
                                Add your first song
                            </Link>
                        </li>
                        <li className="setup-step">
                            <span className="setup-step-num">3</span>
                            <div className="setup-step-text">
                                <span className="setup-step-title">
                                    Create an event
                                </span>
                                <span className="setup-step-sub">
                                    Then draft a set for it.
                                </span>
                            </div>
                            <Link
                                href={`${base}/events/new`}
                                className="setup-step-cta"
                            >
                                Create event →
                            </Link>
                        </li>
                    </ol>
                </section>
            )}
            {next && (
                <section className="hub-hero">
                    <div className="hub-hero-main">
                        <span className="eyebrow">Next event</span>
                        <h1 className="hub-hero-title">{next.name}</h1>
                        <div className="hub-hero-meta">{heroMeta}</div>
                    </div>
                    <div className="hub-hero-avail">
                        <span className="eyebrow">Availability</span>
                        <div className="hub-metric">
                            <span className="metric-num">
                                {avIn}
                                <span className="metric-den">
                                    /{singers.length}
                                </span>
                            </span>
                        </div>
                        <div className="avail-break">
                            {avIn} in · {avOut} out · {avMaybe} maybe
                            {avPending > 0 ? ` · ${avPending} pending` : ""}
                        </div>
                        <Link
                            href={`${base}/events/${next.publicId}`}
                            className="hero-avail-action"
                        >
                            {avPending > 0
                                ? `Nudge ${avPending} →`
                                : "View RSVPs →"}
                        </Link>
                    </div>
                    <div className="hub-hero-aside">
                        {verdict && (
                            <div
                                className={`hero-callout ${verdict.klass}`.trim()}
                            >
                                <span className="delta">{verdict.delta}</span>
                                <span>{verdict.text}</span>
                            </div>
                        )}
                        <div className="hero-chartmetric">
                            {heroArc && (
                                <svg
                                    className="hero-chart"
                                    width={heroArcW}
                                    height={ARC_H}
                                    viewBox={`0 0 ${heroArcW} ${ARC_H}`}
                                    fill="none"
                                    role="img"
                                    aria-label="Energy arc of the drafted set"
                                >
                                    {heroArc.map((b, i) => (
                                        <rect
                                            key={i}
                                            x={b.x}
                                            y={b.y}
                                            width={BAR_W}
                                            height={b.h}
                                            rx="2"
                                            fill={b.fill}
                                        />
                                    ))}
                                </svg>
                            )}
                            <div className="hub-metric">
                                {fill ? (
                                    <span className="metric-num">
                                        {Math.round(fill.filled / 60)}
                                        <span className="metric-den">
                                            /{Math.round(fill.target / 60)}
                                        </span>
                                    </span>
                                ) : (
                                    <span className="metric-num">
                                        {next.resolved.targetDurationSeconds !=
                                        null
                                            ? formatSeconds(
                                                  next.resolved
                                                      .targetDurationSeconds,
                                              )
                                            : "—"}
                                    </span>
                                )}
                                <span className="metric-unit">
                                    {fill ? "minutes" : "target"}
                                </span>
                            </div>
                        </div>
                        <div className="hero-cta">
                            <Link href={draftHref} className="perform">
                                Continue draft →
                            </Link>
                        </div>
                    </div>
                </section>
            )}

            <div className="hub-stats">
                <div className="stat-card">
                    <span className="eyebrow">Repertoire</span>
                    <div className="stat-val">{activeSongs.length} songs</div>
                    <div className="readiness-bar" aria-hidden="true">
                        {readiness.ready > 0 && (
                            <span
                                className="readiness-seg ready"
                                style={{ flex: readiness.ready }}
                            />
                        )}
                        {readiness.polishing > 0 && (
                            <span
                                className="readiness-seg polishing"
                                style={{ flex: readiness.polishing }}
                            />
                        )}
                        {readiness.learning > 0 && (
                            <span
                                className="readiness-seg learning"
                                style={{ flex: readiness.learning }}
                            />
                        )}
                        {readiness.dormant > 0 && (
                            <span
                                className="readiness-seg dormant"
                                style={{ flex: readiness.dormant }}
                            />
                        )}
                    </div>
                    <div className="readiness-legend">
                        <span className="leg-ready">
                            {readiness.ready} ready
                        </span>{" "}
                        ·{" "}
                        <span className="leg-polishing">
                            {readiness.polishing} polishing
                        </span>{" "}
                        ·{" "}
                        <span className="leg-learning">
                            {readiness.learning} learning
                        </span>{" "}
                        ·{" "}
                        <span className="leg-dormant">
                            {readiness.dormant} dormant
                        </span>
                    </div>
                </div>

                <div className="stat-card">
                    <span className="eyebrow">Coverage</span>
                    <div className="stat-val">{fragile} fragile</div>
                    <div className="stat-sub">{coverageSub}</div>
                    <Link
                        href={`${base}/insights/coverage`}
                        className="stat-action"
                    >
                        Review →
                    </Link>
                </div>

                <div className="stat-card">
                    <span className="eyebrow">Recency</span>
                    <div className="recency-split">
                        <div className="recency-metric">
                            <div className="stat-val">{stale}</div>
                            {stale === 0 ? (
                                <div className="stat-sub good">
                                    every song performed within 90 days
                                </div>
                            ) : (
                                <>
                                    <div className="stat-sub">
                                        not performed in 90+ days
                                    </div>
                                    <Link
                                        href={`${base}/insights/history#not-performed`}
                                        className="stat-action"
                                    >
                                        See list →
                                    </Link>
                                </>
                            )}
                        </div>
                        <div className="recency-metric">
                            <div className="stat-val">{goneCold}</div>
                            {goneCold === 0 ? (
                                <div className="stat-sub good">
                                    every ready song rehearsed within 90 days
                                </div>
                            ) : (
                                <>
                                    <div className="stat-sub">
                                        not rehearsed in 90+ days
                                    </div>
                                    <Link
                                        href={`${base}/insights/history#not-rehearsed`}
                                        className="stat-action"
                                    >
                                        See list →
                                    </Link>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="dash-panels">
                <section className="panel set-panel">
                    <div className="panel-head">
                        <h2 className="panel-title">Set in progress</h2>
                        {fill && (
                            <span className="minutes-pill">
                                {Math.round(fill.filled / 60)} /{" "}
                                {Math.round(fill.target / 60)} min
                            </span>
                        )}
                    </div>
                    {setSongs.length > 0 ? (
                        <div className="set-rows">
                            {seamSummary.dominant.length > 0 && (
                                <p className="set-seam-summary">
                                    {seamSummary.dominant
                                        .map((d) => d.label)
                                        .join(" · ")}{" "}
                                    on most transitions.
                                </p>
                            )}
                            {setSongs.map((item, i) => {
                                const song = item.song;
                                const seam =
                                    i < setSongs.length - 1
                                        ? seamByFrom.get(song.id)
                                        : undefined;
                                const seamFlags = seam
                                    ? (seamSummary.reduced.get(song.id) ??
                                      seam.flags)
                                    : [];
                                return (
                                    <div key={song.id} className="set-group">
                                        <div className="set-row">
                                            <span className="set-idx">
                                                {i + 1}
                                            </span>
                                            <span className="set-title">
                                                {song.title}
                                            </span>
                                            <span className="set-key">
                                                {formatKeyRange(
                                                    song.startKey,
                                                    song.endKey,
                                                )}
                                            </span>
                                            <span className="set-tempo">
                                                {song.startTempoBpm != null
                                                    ? song.startTempoBpm
                                                    : "—"}{" "}
                                                ·{" "}
                                                {song.durationSeconds != null
                                                    ? formatSeconds(
                                                          song.durationSeconds,
                                                      )
                                                    : "—"}
                                            </span>
                                            <IntensityDots
                                                value={song.intensity}
                                            />
                                        </div>
                                        {seamFlags.length > 0 && (
                                            <div className="set-seam">
                                                <span
                                                    className="set-seam-rule"
                                                    aria-hidden="true"
                                                />
                                                <span className="set-seam-flags">
                                                    {seamFlags
                                                        .map(seamFlagLabel)
                                                        .join(" · ")}
                                                </span>
                                                <span
                                                    className="set-seam-rule"
                                                    aria-hidden="true"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="panel-empty">
                            No draft yet. Start one from the event.
                        </p>
                    )}
                    {footVerdict && (
                        <div className="panel-foot">
                            <span
                                className={`foot-verdict ${footVerdict.klass}`}
                            >
                                {footVerdict.text}
                            </span>
                            <Link href={draftHref} className="panel-action">
                                Open the set →
                            </Link>
                        </div>
                    )}
                </section>

                {/* Hide the "caught up" reassurance while the book is empty: with nothing built yet it
            reads as false comfort. The setup rail above carries the real next step. */}
                {(needs.length > 0 || activeSongs.length > 0) && (
                    <section className="panel needs-panel">
                        <h2 className="panel-title">Needs you</h2>
                        {needs.length > 0 ? (
                            <div className="needs-list">
                                {needs.map((n) => (
                                    <div
                                        key={n.key}
                                        className={`need-row ${n.tone}`}
                                    >
                                        <div className="need-text">
                                            <div className="need-line1">
                                                {n.line1}
                                            </div>
                                            <div className="need-line2">
                                                {n.line2}
                                            </div>
                                        </div>
                                        <Link
                                            href={n.href}
                                            className="need-action"
                                        >
                                            {n.action}
                                        </Link>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="panel-empty">You’re all caught up.</p>
                        )}
                    </section>
                )}
            </div>
        </main>
    );
}
