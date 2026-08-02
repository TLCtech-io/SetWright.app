// Stage 1: feasibility (hard gate).
//
// Can the available, cast singers cover every required part at the count it
// needs? The catch a human misses by hand: one person cannot sing two lines
// at once. So this is an assignment problem, not a per-part headcount. A
// member cast to both Soprano and Solo can fill one of them, not both.
//
// We expand each required part into `countNeeded` slots and find a maximum
// matching between slots and available cast members. The song is feasible
// only if every required slot is matched.
//
// Range is intentionally not used here: castings already encode who covers a
// part. Range matching lives in the casting-suggestion pass, casting/suggest.ts.

import type { Casting, ID, Part, Song } from "../types.js";

export interface SongIndex {
    song: Song;
    parts: Part[];
}

export interface FeasibilityInput {
    songIndex: SongIndex;
    castingsByPart: Map<ID, Casting[]>;
    availableMemberIds: Set<ID>;
}

export interface FeasibilityResult {
    feasible: boolean;
    /** Required parts that could not be fully covered. */
    shortParts: { label: string; needed: number; covered: number }[];
    /** The member-to-part matching the algorithm found. The chase lever reads it
     *  to name who an optimistic pass relies on. */
    assignment: { memberId: ID; partId: ID; label: string }[];
}

export function checkFeasibility(input: FeasibilityInput): FeasibilityResult {
    const { songIndex, castingsByPart, availableMemberIds } = input;
    const requiredParts = songIndex.parts.filter((p) => p.isRequired);

    // One slot per required seat.
    interface Slot {
        partId: ID;
    }
    const slots: Slot[] = [];
    for (const p of requiredParts) {
        const n = Math.max(1, p.countNeeded);
        for (let i = 0; i < n; i++) slots.push({ partId: p.id });
    }

    // For each slot, the available members cast to that part.
    const eligibleForSlot: ID[][] = slots.map((slot) => {
        const castings = castingsByPart.get(slot.partId) ?? [];
        return castings
            .map((c) => c.memberId)
            .filter((mid) => availableMemberIds.has(mid));
    });

    // Kuhn's algorithm: match slots (left) to members (right).
    const memberToSlot = new Map<ID, number>();
    const slotMatched = new Array<boolean>(slots.length).fill(false);

    const tryAssign = (slotIdx: number, seen: Set<ID>): boolean => {
        for (const mid of eligibleForSlot[slotIdx]!) {
            if (seen.has(mid)) continue;
            seen.add(mid);
            const taken = memberToSlot.get(mid);
            if (taken === undefined || tryAssign(taken, seen)) {
                memberToSlot.set(mid, slotIdx);
                slotMatched[slotIdx] = true;
                return true;
            }
        }
        return false;
    };

    for (let s = 0; s < slots.length; s++) {
        tryAssign(s, new Set<ID>());
    }

    // Tally coverage per required part.
    const needed = new Map<ID, number>();
    const covered = new Map<ID, number>();
    slots.forEach((slot, idx) => {
        needed.set(slot.partId, (needed.get(slot.partId) ?? 0) + 1);
        if (slotMatched[idx]) {
            covered.set(slot.partId, (covered.get(slot.partId) ?? 0) + 1);
        }
    });

    const shortParts: FeasibilityResult["shortParts"] = [];
    for (const p of requiredParts) {
        const n = needed.get(p.id) ?? 0;
        const c = covered.get(p.id) ?? 0;
        if (c < n) shortParts.push({ label: p.label, needed: n, covered: c });
    }

    // The matching as member -> part, for the chase lever's attribution.
    const labelByPart = new Map(requiredParts.map((p) => [p.id, p.label]));
    const assignment: FeasibilityResult["assignment"] = [];
    for (const [memberId, slotIdx] of memberToSlot) {
        const partId = slots[slotIdx]!.partId;
        assignment.push({
            memberId,
            partId,
            label: labelByPart.get(partId) ?? "",
        });
    }

    return { feasible: shortParts.length === 0, shortParts, assignment };
}
