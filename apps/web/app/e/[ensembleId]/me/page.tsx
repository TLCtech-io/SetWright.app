import Link from "next/link";
import { noteName } from "@repertoire/core";
import type { MemberRow } from "@/lib/db";
import { getRepository } from "@/lib/repository";
import { getMyMembership } from "@/lib/ensembles";
import { formatEventDate, todayInTz } from "@/lib/format";
import { soloistEquity } from "@/lib/equity";
import { MySolos } from "@/components/MySolos";

// The member's own answer for the next event, phrased back to them.
const NEXT_RSVP: Record<string, string> = {
    in: "You're in",
    tentative: "You said maybe",
    out: "You're out",
};

// The member's own home. Reads mutable state, so render per request.
export const dynamic = "force-dynamic";

function rangeLabel(m: MemberRow): string {
    if (m.rangeLowMidi == null && m.rangeHighMidi == null) return "not set";
    const lo = m.rangeLowMidi != null ? noteName(m.rangeLowMidi) : "?";
    const hi = m.rangeHighMidi != null ? noteName(m.rangeHighMidi) : "?";
    return `${lo}–${hi}`;
}

export default async function MyHomePage({
    params,
}: {
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const me = await getMyMembership(ensembleId);
    const repo = getRepository();
    const member = me ? await repo.getMember(me.memberId) : undefined;
    const voiceParts = await repo.listVoiceParts();
    const vpById = new Map(voiceParts.map((v) => [v.id, v.label] as const));

    if (!me || !member) {
        return (
            <main className="page">
                <div className="page-head">
                    <h1>Your space</h1>
                </div>
                <p className="empty">
                    We couldn't find your membership in this ensemble.
                </p>
            </main>
        );
    }

    const sections = member.sections
        .map((s) => ({ label: vpById.get(s.voicePartId), home: s.isPrimary }))
        .filter((s): s is { label: string; home: boolean } => !!s.label);
    const sectionList = sections.length
        ? sections
              .sort((a, b) => (a.home === b.home ? 0 : a.home ? -1 : 1))
              .map((s) => `${s.label}${s.home ? " ★" : ""}`)
              .join(", ")
        : "none assigned";

    // Each card previews the one number worth acting on, the same way the Insights hub
    // does: parts still to rate, events still to RSVP, and the member's own range.
    const castings = await repo.listMyCastings();
    const toRate = castings.filter((c) => c.confidence == null).length;
    // Members RSVP to rehearsals too, so this count mirrors the schedule page (both kinds).
    const schedule = (await repo.listEvents({ kind: "all" })).filter(
        (e) => e.status !== "cancelled",
    );
    const toRsvp = schedule.filter(
        (e) => !e.availability.find((a) => a.memberId === me.memberId)?.status,
    ).length;

    // The soonest upcoming event (dated today or later), with the member's own answer — a nudge to
    // act sits at the top of their space. "Today" is the ensemble's day boundary, same as the rest.
    const today = todayInTz((await repo.getEnsembleSettings()).timezone);
    const nextUp = schedule
        .filter(
            (e) =>
                e.resolved.eventDate != null && e.resolved.eventDate >= today,
        )
        .sort((a, b) =>
            (a.resolved.eventDate ?? "").localeCompare(
                b.resolved.eventDate ?? "",
            ),
        )[0];
    const nextStatus =
        nextUp?.availability.find((a) => a.memberId === me.memberId)?.status ??
        null;

    // The member's own feature history, sliced from the shared soloist-equity reader. The average
    // is over the active pool (the members currently sharing the solos), so a member sees their
    // own count against a live baseline. Departed soloists are excluded from that baseline.
    const [appearances, pool] = await Promise.all([
        repo.listSoloistAppearances(),
        repo.listMembers(),
    ]);
    const equity = soloistEquity(appearances, pool);
    const myEquity = equity.find((r) => r.memberId === me.memberId) ?? null;
    const activeRows = equity.filter((r) => !r.departed);
    const soloAverage = activeRows.length
        ? activeRows.reduce((n, r) => n + r.count, 0) / activeRows.length
        : 0;

    // Range is the one thing a fresh member can act on before their director casts them.
    const rangeUnset =
        member.rangeLowMidi == null && member.rangeHighMidi == null;

    return (
        <main className="page hub-menu">
            <div className="page-head">
                <div>
                    <h1>Hi, {member.displayName}</h1>
                    <div className="sub">Your space in this ensemble</div>
                </div>
            </div>

            {nextUp ? (
                <Link
                    href={`/e/${ensembleId}/events/${nextUp.publicId}`}
                    className={`nextup${nextStatus == null ? " unanswered" : ""}`}
                >
                    <span className="nextup-eyebrow">Next up</span>
                    <span className="nextup-title">
                        {nextUp.name}
                        {nextUp.kind === "rehearsal" && (
                            <span className="role-tag">rehearsal</span>
                        )}
                    </span>
                    <span className="nextup-meta">
                        {[
                            formatEventDate(nextUp.resolved.eventDate),
                            nextUp.venue,
                        ]
                            .filter(Boolean)
                            .join(" · ") || "Date TBD"}
                    </span>
                    <span
                        className={`nextup-rsvp${nextStatus == null ? " warn" : ""}`}
                    >
                        {nextStatus == null
                            ? "Not responded. Tap to RSVP."
                            : NEXT_RSVP[nextStatus]}
                    </span>
                </Link>
            ) : castings.length === 0 ? (
                // A brand-new singer with no event to RSVP to and nothing cast yet: orient them, and point
                // at the one thing they can do now.
                <div className="empty">
                    <p>
                        Welcome. Your director sets your parts and schedule.
                        {rangeUnset
                            ? " While you wait, set your voice range so solos get sized to you."
                            : ""}
                    </p>
                    {rangeUnset && (
                        <Link
                            href={`/e/${ensembleId}/me/profile`}
                            className="empty-cta"
                        >
                            Set your range &rarr;
                        </Link>
                    )}
                </div>
            ) : null}

            <div className="cards">
                <Link href={`/e/${ensembleId}/me/schedule`} className="card">
                    <div className="card-head">
                        <span className="card-title">Your schedule</span>
                        <span
                            className={`card-stat${toRsvp > 0 ? " warn" : ""}`}
                        >
                            {toRsvp > 0
                                ? `${toRsvp} to RSVP`
                                : `${schedule.length} event${schedule.length === 1 ? "" : "s"}`}
                        </span>
                    </div>
                    <div className="card-sub">
                        RSVP to upcoming events so your director knows
                        who&apos;ll be there.
                    </div>
                </Link>

                <Link href={`/e/${ensembleId}/me/parts`} className="card">
                    <div className="card-head">
                        <span className="card-title">Your parts</span>
                        <span
                            className={`card-stat${toRate > 0 ? " warn" : ""}`}
                        >
                            {toRate > 0
                                ? `${toRate} to rate`
                                : `${castings.length} cast`}
                        </span>
                    </div>
                    <div className="card-sub">
                        See the songs you&apos;re cast on and tell your director
                        how solid you feel.
                    </div>
                </Link>

                <Link href={`/e/${ensembleId}/me/profile`} className="card">
                    <div className="card-head">
                        <span className="card-title">Your profile</span>
                        <span className="card-stat">{rangeLabel(member)}</span>
                    </div>
                    <div className="card-sub">
                        Sections: {sectionList} (set by your director). Update
                        your name and range.
                    </div>
                </Link>
            </div>

            <MySolos row={myEquity} average={soloAverage} />
        </main>
    );
}
