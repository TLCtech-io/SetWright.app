// The chase lever.
//
// When a song falls out at feasibility, the shortfall names the part nobody
// available can cover. Often the real lever is softer: a singer said "maybe", or
// has not replied. Those are chaseable; one text could flip the night. This
// names them.
//
// The method: draft twice and diff the feasibility drops. The
// baseline is the availability the real draft uses (in, plus tentatives only if
// the option is set). The optimistic pass counts everyone who has not said no:
// in, tentative, and no-response from the roster. A song blocked at the baseline
// but feasible optimistically is one a chased RSVP would open, so long as it
// would also clear readiness and context. Out is a real no, never chaseable.

import type { DraftInput, ID } from "../types.js";
import { DEFAULT_READINESS_FLOOR } from "../types.js";
import { indexBySong, indexByPart } from "../group.js";
import { checkFeasibility } from "./feasibility.js";
import { checkReadiness } from "./readiness.js";
import { checkContext } from "./context.js";
import { stageTime } from "./selection.js";
import { resolveForced } from "./options.js";

/** A person to chase, and the part their RSVP would cover. */
export interface ChaseTarget {
    memberId: ID;
    displayName: string;
    partLabel: string;
}

/** A feasibility-blocked song a chased RSVP would open. */
export interface ChaseCandidate {
    songId: ID;
    title: string;
    secondsUnlocked: number; // padded stage time the song would add
    chase: ChaseTarget[]; // who to chase to open it
}

export function computeChase(input: DraftInput): ChaseCandidate[] {
    const { songs, parts, castings, availability, event } = input;
    const opt = input.options ?? {};
    const readinessFloor = opt.readinessFloor ?? DEFAULT_READINESS_FLOOR;

    const partsBySong = indexBySong(parts);
    const castingsByPart = indexByPart(castings);

    const statusOf = new Map(availability.map((a) => [a.memberId, a.status]));
    const rosterName = new Map(
        (input.members ?? []).map((m) => [m.id, m.displayName]),
    );

    // Baseline: the availability the real draft uses.
    const baseline = new Set<ID>();
    for (const a of availability) {
        if (a.status === "in") baseline.add(a.memberId);
        if (a.status === "tentative" && opt.countTentativeAsAvailable)
            baseline.add(a.memberId);
    }
    // Optimistic: everyone who has not said out. Roster members with no row are
    // no-response, also chaseable. Without a roster this falls back to tentatives.
    const optimistic = new Set<ID>();
    for (const m of input.members ?? []) {
        if (statusOf.get(m.id) !== "out") optimistic.add(m.id);
    }
    for (const a of availability) {
        if (a.status !== "out") optimistic.add(a.memberId);
    }
    const newlyAvailable = new Set<ID>(
        [...optimistic].filter((id) => !baseline.has(id)),
    );

    // Forced songs (open/close/keep) bypass the gates and are already in the set,
    // so they are never chase candidates. Same resolution the funnel uses.
    const { forcedIds } = resolveForced(opt);
    const excluded = new Set(opt.excluded ?? []);
    // Preferred (prep) songs bypass the soft gates in the funnel, so they must here too: a below-floor
    // or context-ineligible prep commitment that a chased RSVP would make castable belongs in the set,
    // and skipping it at readiness/context would leave the shortfall with no lever to name. Same
    // preferred set the funnel resolves.
    const preferIds = new Set(
        (opt.prefer ?? []).filter(
            (id) => !forcedIds.has(id) && !excluded.has(id),
        ),
    );

    const candidates: ChaseCandidate[] = [];
    for (const song of songs) {
        if (forcedIds.has(song.id) || excluded.has(song.id)) continue;
        const sParts = partsBySong.get(song.id) ?? [];

        const feasBase = checkFeasibility({
            songIndex: { song, parts: sParts },
            castingsByPart,
            availableMemberIds: baseline,
        });
        if (feasBase.feasible) continue; // already coverable, nothing to chase

        const feasOpt = checkFeasibility({
            songIndex: { song, parts: sParts },
            castingsByPart,
            availableMemberIds: optimistic,
        });
        if (!feasOpt.feasible) continue; // chasing will not cover it; a hard out

        // Only a lever if the song would actually join the set once feasible. A preferred (prep) song
        // bypasses these soft gates in the funnel, so skip them here too — the chase is still real.
        if (!preferIds.has(song.id)) {
            const read = checkReadiness({
                song,
                parts: sParts,
                castingsByPart,
                availableMemberIds: optimistic,
                event,
                readinessFloor,
            });
            if (!read.eligible) continue;
            if (!checkContext(song, event, opt.context).eligible) continue;
        }

        // No duration means it cannot be length-placed, so a chase would not open
        // it. The funnel drops it at the data stage for the same reason.
        const stage = stageTime(song, event.padding);
        if (stage === null) continue;

        // Who to chase: the newly-available members the optimistic matching relies
        // on, each labelled by the part it assigned them to. Attributing through the
        // assignment, not the baseline short parts, catches the case where a
        // cross-cast member frees someone else to cover the part that was short.
        const targets: ChaseTarget[] = [];
        const seen = new Set<string>();
        for (const a of feasOpt.assignment) {
            if (!newlyAvailable.has(a.memberId)) continue;
            const key = `${a.memberId}:${a.partId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({
                memberId: a.memberId,
                displayName: rosterName.get(a.memberId) ?? a.memberId,
                partLabel: a.label,
            });
        }
        if (targets.length === 0) continue; // optimistic, but no newly-available member used

        candidates.push({
            songId: song.id,
            title: song.title,
            secondsUnlocked: stage,
            chase: targets,
        });
    }
    return candidates;
}
