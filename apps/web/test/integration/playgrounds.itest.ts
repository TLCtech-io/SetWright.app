// Playground (program) domain.
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    const { repo, client } = await signInAs("ana@example.com");
    const songs = await repo.listSongs();
    const id = (t: string) => songs.find((s) => s.title.startsWith(t))!.id;
    const wade = id("Wade");
    const lean = id("Lean");
    const stand = id("Stand");
    const concert = (await repo.listEvents()).find(
        (e) => e.name === "Summer concert",
    )!;

    const pgs = await repo.listPlaygrounds();
    assert(
        pgs.length === 1 && pgs[0]!.name === "Spring concert",
        "seeded playground",
    );
    const spring = pgs[0]!;
    assert(
        spring.songIds.join() === [stand, lean, wade].join(),
        "ordered songIds",
    );
    assert(
        spring.open === stand && spring.close === wade,
        "open/close anchors",
    );
    assert(
        (await repo.getPlayground(spring.id))?.id === spring.id,
        "getPlayground",
    );

    const made = await repo.createPlayground("Draft Program");
    assert(
        made.songIds.length === 0 && made.open === null,
        "createPlayground is empty",
    );
    const upd = await repo.updatePlayground(made.id, {
        name: "My Program",
        songIds: [wade, lean],
        open: wade,
        close: lean,
    });
    assert(
        upd?.name === "My Program" && upd?.open === wade && upd?.close === lean,
        "updatePlayground sets arrangement + anchors",
    );
    const upd2 = await repo.updatePlayground(made.id, {
        songIds: [wade],
        open: lean,
        close: wade,
    });
    assert(
        upd2?.open === null && upd2?.close === wade,
        "anchor consistency: open nulled (not in songIds), close kept",
    );

    assert(
        (await repo.isPlaygroundAssigned(spring.id)) === false,
        "unassigned before instantiation",
    );
    const sl = await repo.createSetlistFromPlayground(spring.id, concert.id);
    assert(
        sl?.status === "draft" && sl?.name === "Spring concert",
        "createSetlistFromPlayground makes a draft",
    );
    const locks = (
        await client.rpc("hydrate_setlist_locks", { p_setlist: sl!.id })
    ).data as { opens: string[]; closes: string[]; keep: string[] };
    assert(
        locks.opens[0] === stand &&
            locks.closes[0] === wade &&
            locks.keep.includes(lean),
        "instantiated setlist carries program pins",
    );
    assert(
        (await repo.isPlaygroundAssigned(spring.id)) === true,
        "assigned after instantiation",
    );
    const delAssigned = await repo.deletePlayground(spring.id);
    assert(
        !delAssigned.ok && delAssigned.reason === "assigned",
        "deletePlayground refuses an assigned program",
    );
    assert(
        (await repo.deletePlayground(made.id)).ok,
        "deletePlayground removes an unassigned program",
    );
}
