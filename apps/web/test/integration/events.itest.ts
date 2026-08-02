// Events domain.
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    const { repo } = await signInAs("ana@example.com");

    const events = await repo.listEvents();
    assert(events.length === 2, "2 events in A");
    const concert = events.find((e) => e.name === "Summer concert")!;
    assert(
        concert.resolved.padding.perSongSeconds === 30 &&
            concert.resolved.padding.perSetSeconds === 90,
        "concert padding snapshot",
    );
    assert(
        concert.resolved.allowsOnBook === true &&
            concert.resolved.targetDurationSeconds === 1140,
        "concert policy snapshot",
    );
    assert(
        concert.availability.length === 4 &&
            concert.availability.every((a) => a.status === "in"),
        "concert RSVPs",
    );
    assert(concert.eventTypeId !== null, "concert is typed");
    const winter = events.find((e) => e.name === "Winter showcase")!;
    assert(winter.eventTypeId === null, "winter is untyped");
    assert(
        (await repo.getEventSetlists(concert.id)).length === 1,
        "concert has 1 setlist",
    );

    const made = await repo.createEvent({
        name: "Spring Gala",
        venue: "The Hall",
        status: "planned",
        kind: "gig",
        eventTypeId: null,
        eventDate: "2026-05-01",
        targetDurationSeconds: 1200,
        maxDurationSeconds: null,
        allowsOnBook: false,
        allowsExplicit: false,
        allowsAccompaniment: true,
        perSongSeconds: 25,
        perSetSeconds: 75,
        excludeTags: ["ballad"],
        preferTags: ["soul", "ballad"],
        requireTags: [],
    });
    assert(
        made.resolved.padding.perSongSeconds === 25,
        "createEvent maps the snapshot",
    );
    assert(
        made.availability.length === 0,
        "createEvent seeds no RSVPs (members are pending until they respond)",
    );
    assert(
        made.excludeTags.join() === "ballad" &&
            made.preferTags.join() === "soul",
        "createEvent tag rules exclude-wins",
    );
    assert(
        (await repo.getEventSetlists(made.id)).length === 1,
        "createEvent makes a draftable setlist",
    );

    const upd = await repo.updateEvent(made.id, {
        name: "Spring Gala 2",
        venue: "The Hall",
        status: "planned",
        kind: "gig",
        eventTypeId: null,
        eventDate: "2026-05-02",
        targetDurationSeconds: 1000,
        maxDurationSeconds: null,
        allowsOnBook: true,
        allowsExplicit: false,
        allowsAccompaniment: true,
        perSongSeconds: 20,
        perSetSeconds: 60,
        excludeTags: [],
        preferTags: ["gospel"],
        requireTags: [],
    });
    assert(
        upd?.resolved.allowsOnBook === true &&
            upd?.preferTags.join() === "gospel",
        "updateEvent updates snapshot + tags",
    );
    const ana = (await repo.listMembers()).find(
        (m) => m.displayName === "Ana",
    )!.id;
    const evVer = (await repo.getEvent(made.id))!.version!;
    const saved = await repo.setAvailability(
        made.id,
        [{ memberId: ana, status: "out" }],
        evVer,
    );
    assert(
        saved.ok && saved.version !== evVer,
        "setAvailability succeeds and bumps the version",
    );
    assert(
        (await repo.getEvent(made.id))?.availability.length === 1,
        "setAvailability replaced RSVPs",
    );
    // Optimistic concurrency: re-using the now-stale token is rejected, no clobber.
    const stale = await repo.setAvailability(
        made.id,
        [{ memberId: ana, status: "in" }],
        evVer,
    );
    assert(
        !stale.ok && stale.reason === "conflict",
        "a stale version conflicts instead of overwriting",
    );
    assert(
        (await repo.getEvent(made.id))?.availability[0]?.status === "out",
        "the conflicting write did not apply",
    );

    const delPerf = await repo.deleteEvent(winter.id);
    assert(
        !delPerf.ok && delPerf.reason === "has-performed",
        "deleteEvent refuses an event with a performed set",
    );
    assert(
        (await repo.deleteEvent(made.id)).ok &&
            (await repo.getEvent(made.id)) === undefined,
        "deleteEvent removes a deletable event",
    );

    const concertType = (await repo.listEventTypes()).find(
        (t) => t.name === "Concert",
    )!;
    assert(
        (await repo.deleteEventType(concertType.id)).ok,
        "deleteEventType succeeds (composite SET NULL)",
    );
    assert(
        (await repo.getEvent(concert.id))?.eventTypeId === null,
        "the referencing event survives with eventTypeId nulled",
    );

    // A rehearsal is created with kind, no seeded RSVPs, and NO
    // setlist (the drafter's gig set is gig-only). listEvents is fail-closed by kind.
    const reh = await repo.createEvent({
        name: "Weeknight rehearsal",
        venue: null,
        status: "planned",
        kind: "rehearsal",
        eventTypeId: null,
        eventDate: "2026-05-10",
        targetDurationSeconds: 5400,
        maxDurationSeconds: null,
        allowsOnBook: true,
        allowsExplicit: false,
        allowsAccompaniment: true,
        perSongSeconds: 30,
        perSetSeconds: 60,
        excludeTags: [],
        preferTags: [],
        requireTags: [],
    });
    assert(reh.kind === "rehearsal", "createEvent persists kind rehearsal");
    assert(
        (await repo.getEventSetlists(reh.id)).length === 0,
        "a rehearsal gets no setlist",
    );
    assert(reh.availability.length === 0, "a rehearsal seeds no RSVPs either");
    // Fail-closed: the default gig-only list excludes it; kind:'all' includes it.
    assert(
        !(await repo.listEvents()).some((e) => e.id === reh.id),
        "listEvents() defaults to gigs, excluding the rehearsal",
    );
    assert(
        (await repo.listEvents({ kind: "all" })).some((e) => e.id === reh.id),
        "listEvents({kind:all}) includes the rehearsal",
    );
    assert(
        (await repo.listEvents({ kind: "rehearsal" })).every(
            (e) => e.kind === "rehearsal",
        ),
        "listEvents({kind:rehearsal}) returns only rehearsals",
    );
    // kind is immutable: an edit that submits kind:'gig' does not flip it.
    const rehUpd = await repo.updateEvent(reh.id, {
        name: "Weeknight rehearsal 2",
        venue: null,
        status: "planned",
        kind: "gig",
        eventTypeId: null,
        eventDate: "2026-05-11",
        targetDurationSeconds: 5400,
        maxDurationSeconds: null,
        allowsOnBook: true,
        allowsExplicit: false,
        allowsAccompaniment: true,
        perSongSeconds: 30,
        perSetSeconds: 60,
        excludeTags: [],
        preferTags: [],
        requireTags: [],
    });
    assert(
        rehUpd?.kind === "rehearsal",
        "updateEvent does not flip kind (immutable), stays rehearsal",
    );
    assert(
        (await repo.getEventSetlists(reh.id)).length === 0,
        "the rehearsal still has no setlist after an edit",
    );

    // The agenda is a replace-write of ordered items: deduped by
    // song (first occurrence kept), notes trimmed, positions gapless, kind-guarded so a
    // gig can never acquire one. getRehearsalAgenda reads it back in order.
    const songIds = (await repo.listSongs()).map((s) => s.id);
    assert(songIds.length >= 2, "seed has at least two songs to plan");
    const [sa, sb] = songIds as [string, string];
    await repo.saveRehearsalAgenda(reh.id, [
        { songId: sb, reason: "learning-gap", note: "  polish the tag  " },
        { songId: sa, reason: "coverage-risk", note: null },
        { songId: sb, reason: "stale", note: "duplicate song, dropped" },
    ]);
    const agenda = await repo.getRehearsalAgenda(reh.id);
    assert(agenda.length === 2, "agenda deduped by song");
    assert(
        agenda[0]?.songId === sb && agenda[1]?.songId === sa,
        "agenda keeps submitted order, first occurrence of a song",
    );
    assert(
        agenda[0]?.reason === "learning-gap" &&
            agenda[0]?.note === "polish the tag",
        "reason kept, note trimmed",
    );
    assert(agenda[1]?.note === null, "a null note round-trips as null");
    // Replacing with an empty list clears it.
    await repo.saveRehearsalAgenda(reh.id, []);
    assert(
        (await repo.getRehearsalAgenda(reh.id)).length === 0,
        "an empty agenda write clears the plan",
    );
    // Kind guard: a gig cannot get an agenda (the RPC raises).
    let guarded = false;
    try {
        await repo.saveRehearsalAgenda(concert.id, [
            { songId: sa, reason: null, note: null },
        ]);
    } catch {
        guarded = true;
    }
    assert(guarded, "saveRehearsalAgenda rejects a gig event (kind guard)");

    // mark_songs_rehearsed stamps last_rehearsed monotonically
    // (greatest), and save_attendance records who came (replace-write, deduped by member).
    const song0 = sa; // reuse a real song id from the agenda block
    await repo.markSongsRehearsed([song0], "2030-06-15");
    assert(
        (await repo.getSong(song0))?.lastRehearsed === "2030-06-15",
        "mark_songs_rehearsed stamps last_rehearsed forward",
    );
    await repo.markSongsRehearsed([song0], "2029-01-01"); // earlier: greatest keeps the later date
    assert(
        (await repo.getSong(song0))?.lastRehearsed === "2030-06-15",
        "an earlier date does not move last_rehearsed back",
    );

    const memIds = (await repo.listRoster()).map((m) => m.id);
    assert(memIds.length >= 2, "seed has at least two members for attendance");
    const [ma, mb] = memIds as [string, string];
    await repo.saveAttendance(reh.id, [
        { memberId: ma, present: true },
        { memberId: mb, present: false },
        { memberId: ma, present: false }, // duplicate member, last write wins
    ]);
    const att = await repo.getAttendance(reh.id);
    assert(att.length === 2, "attendance deduped by member");
    assert(
        att.find((a) => a.memberId === ma)?.present === false,
        "last write wins on a duplicate member",
    );
    assert(
        att.find((a) => a.memberId === mb)?.present === false,
        "the second member is recorded absent",
    );
    await repo.saveAttendance(reh.id, []);
    assert(
        (await repo.getAttendance(reh.id)).length === 0,
        "an empty attendance write clears it",
    );

    // Prep targets are a gig-only, deduped replace-write set of song ids.
    await repo.savePrepTargets(concert.id, [sb, sa, sb]); // duplicate sb
    const prep = await repo.getPrepTargets(concert.id);
    assert(prep.length === 2, "prep targets deduped by song");
    assert(
        prep.includes(sa) && prep.includes(sb),
        "both distinct target songs saved",
    );
    await repo.savePrepTargets(concert.id, []);
    assert(
        (await repo.getPrepTargets(concert.id)).length === 0,
        "an empty prep write clears the set",
    );
    // Kind guard: a rehearsal is the preparation, it cannot itself carry prep targets.
    let prepGuarded = false;
    try {
        await repo.savePrepTargets(reh.id, [sa]);
    } catch {
        prepGuarded = true;
    }
    assert(
        prepGuarded,
        "savePrepTargets rejects a rehearsal event (kind guard)",
    );
}
