// Public id domain: every routable read model carries a well-formed public_id token, tokens are
// unique, and resolvePublicId round-trips a token back to its uuid (RLS + ensemble scoped, so an
// unknown or wrong-kind token resolves to null). This exercises the ...050 migration, so it is RED
// until that migration is applied to the local stack (supabase db reset).

import { assert, signInAs } from "./helpers";
import { PUBLIC_ID_RE } from "../../lib/publicId";

export async function run(): Promise<void> {
    const { repo, client } = await signInAs("ana@example.com");
    const wellFormed = (v: unknown): boolean =>
        typeof v === "string" && PUBLIC_ID_RE.test(v);

    const songs = await repo.listSongs();
    assert(
        songs.length > 0 && songs.every((s) => wellFormed(s.publicId)),
        "every song carries a token",
    );
    assert(
        new Set(songs.map((s) => s.publicId)).size === songs.length,
        "song tokens are unique",
    );

    const members = await repo.listRoster();
    assert(
        members.length > 0 && members.every((m) => wellFormed(m.publicId)),
        "every member carries a token",
    );

    const events = await repo.listEvents();
    assert(
        events.length > 0 && events.every((e) => wellFormed(e.publicId)),
        "every event carries a token",
    );

    const programs = await repo.listPlaygrounds();
    assert(
        programs.every((p) => wellFormed(p.publicId)),
        "every program carries a token",
    );

    const concert = events.find((e) => e.name === "Summer concert")!;
    const setlists = await repo.listEventSetlists(concert.id);
    assert(
        setlists.length > 0 && setlists.every((s) => wellFormed(s.publicId)),
        "every setlist carries a token",
    );

    // The ensemble row carries one too: it is the /e/:token URL segment.
    const ens = (
        await client.from("ensemble").select("public_id").limit(1).single()
    ).data as { public_id: string } | null;
    assert(!!ens && wellFormed(ens.public_id), "the ensemble carries a token");

    // resolvePublicId maps a token back to its uuid, scoped to the active ensemble.
    const song = songs[0]!;
    assert(
        (await repo.resolvePublicId("song", song.publicId)) === song.id,
        "a song token resolves to its uuid",
    );
    const member = members[0]!;
    assert(
        (await repo.resolvePublicId("member", member.publicId)) === member.id,
        "a member token resolves to its uuid",
    );
    assert(
        (await repo.resolvePublicId("event", concert.publicId)) === concert.id,
        "an event token resolves to its uuid",
    );

    // A token of the wrong kind, or one that names nothing, resolves to null (never a stray row).
    assert(
        (await repo.resolvePublicId("event", song.publicId)) === null,
        "a song token does not resolve as an event",
    );
    assert(
        (await repo.resolvePublicId("song", "AAAAAAAAAAAAAAAAAAAAAA")) === null,
        "an unknown token resolves to null",
    );
}
