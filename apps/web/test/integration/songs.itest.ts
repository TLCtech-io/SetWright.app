// Songs / parts / casting domain.
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    const { repo } = await signInAs("ana@example.com");

    const songs = await repo.listSongs();
    assert(songs.length === 5, "listSongs returns 5");
    const wade = songs.find((s) => s.title.startsWith("Wade"))!;
    assert(
        wade.startKey?.fifths === 0 && wade.startKey?.mode === "major",
        "wade.startKey = C major",
    );
    assert(
        wade.tags
            .map((t) => t.name)
            .sort()
            .join(",") === "gospel,spiritual",
        "wade tags aggregated",
    );
    assert(wade.lastPerformed === "2026-02-14", "wade.lastPerformed");

    const parts = await repo.getSongParts(wade.id);
    assert(parts.length === 2, "wade has 2 parts");
    assert(
        parts.find((p) => p.isSolo)!.voicePartId === null,
        "lead is a solo (no voice part)",
    );
    assert(
        parts.find((p) => !p.isSolo)!.voicePartId !== null,
        "bass section has a voice part",
    );

    const grave = songs.find((s) => s.title.startsWith("Ain't No Grave"))!;
    const gLead = (await repo.getSongCasting(grave.id)).find(
        (c) => c.isPrimary,
    )!;
    assert(
        gLead.confidence === "shaky",
        "director sees self-reported confidence",
    );
    assert(
        gLead.directorAssessed === "learning",
        "director sees director_assessed",
    );

    const created = await repo.createSong({
        song: {
            title: "Test Anthem",
            startKey: { fifths: 2, mode: "major" },
            endKey: null,
            startTempoBpm: 110,
            endTempoBpm: null,
            durationSeconds: 200,
            isExplicit: false,
            usesAccompaniment: false,
            intensity: 4,
            tags: [{ name: "soul", category: "genre" }],
            assessedReadiness: "performance-ready",
            bookStatus: "off-book",
        },
        arranger: "Tester",
        chartRef: null,
        lastRehearsed: null,
        startPitch: "D",
        parts: [
            {
                label: "Lead",
                isRequired: true,
                countNeeded: 1,
                voicePartId: null,
                isSolo: true,
                rangeLowMidi: null,
                rangeHighMidi: null,
            },
        ],
    });
    assert(
        created.tags[0]?.name === "soul" && created.startPitch === "D",
        "createSong maps tags + startPitch",
    );
    const cParts = await repo.getSongParts(created.id);
    assert(
        cParts.length === 1 && cParts[0]!.isSolo,
        "created song has its solo part",
    );

    const createdVer = (await repo.getSong(created.id))!.version!;
    const updated = await repo.updateSong(
        created.id,
        {
            song: {
                ...created,
                title: "Test Anthem v2",
                tags: [
                    { name: "gospel", category: "genre" },
                    { name: "uptempo", category: "groove" },
                ],
            },
            arranger: "Tester2",
            chartRef: null,
            lastRehearsed: null,
            startPitch: null,
            parts: cParts.map((p) => ({
                id: p.id,
                label: p.label,
                isRequired: p.isRequired,
                countNeeded: p.countNeeded,
                voicePartId: p.voicePartId,
                isSolo: p.isSolo,
                rangeLowMidi: p.rangeLowMidi,
                rangeHighMidi: p.rangeHighMidi,
            })),
        },
        createdVer,
    );
    assert(updated.ok, "updateSong succeeds with the loaded version");
    assert(
        (await repo.getSong(created.id))?.tags
            .map((t) => t.name)
            .sort()
            .join(",") === "gospel,uptempo",
        "updateSong retags",
    );
    assert(
        (await repo.getSongParts(created.id))[0]!.id === cParts[0]!.id,
        "kept part survived update",
    );
    // A stale update (the version updateSong just bumped) conflicts instead of clobbering.
    const staleUpd = await repo.updateSong(
        created.id,
        {
            song: { ...created, title: "Should Not Win" },
            arranger: null,
            chartRef: null,
            lastRehearsed: null,
            startPitch: null,
            parts: cParts.map((p) => ({
                id: p.id,
                label: p.label,
                isRequired: p.isRequired,
                countNeeded: p.countNeeded,
                voicePartId: p.voicePartId,
                isSolo: p.isSolo,
                rangeLowMidi: p.rangeLowMidi,
                rangeHighMidi: p.rangeHighMidi,
            })),
        },
        createdVer,
    );
    assert(
        !staleUpd.ok && staleUpd.reason === "conflict",
        "a stale updateSong conflicts",
    );
    assert(
        (await repo.getSong(created.id))?.title === "Test Anthem v2",
        "the conflicting update did not apply",
    );

    const ben = (await repo.listMembers()).find(
        (m) => m.displayName === "Ben",
    )!.id;
    const castVer = (await repo.getSong(created.id))!.version!;
    await repo.setSongCasting(
        created.id,
        [
            {
                partId: cParts[0]!.id,
                memberId: ben,
                isPrimary: true,
                confidence: "solid",
                directorAssessed: "solid",
            },
        ],
        castVer,
    );
    const cast = await repo.getSongCasting(created.id);
    assert(
        cast.length === 1 && cast[0]!.memberId === ben && !!cast[0]!.learnedAt,
        "setSongCasting replaces + stamps learned_at",
    );

    // Atomicity of the transactional casting RPC: a rewrite that violates a constraint
    // mid-flight rolls back ENTIRELY — the claim/version does not advance and the prior casting
    // survives (vs. the old claim-then-replace, which bumped the version then wiped the rows).
    const beforeFail = (await repo.getSong(created.id))!.version!;
    let threw = false;
    try {
        await repo.setSongCasting(
            created.id,
            [
                {
                    partId: cParts[0]!.id,
                    memberId: ben,
                    isPrimary: true,
                    confidence: "solid",
                    directorAssessed: "solid",
                },
                {
                    partId: cParts[0]!.id,
                    memberId: ben,
                    isPrimary: false,
                    confidence: "solid",
                    directorAssessed: "shaky",
                }, // dup (member,part) -> unique violation
            ],
            beforeFail,
        );
    } catch {
        threw = true;
    }
    assert(threw, "a casting rewrite that violates a constraint throws");
    assert(
        (await repo.getSong(created.id))!.version === beforeFail,
        "the failed rewrite rolled back: version did not advance",
    );
    assert(
        (await repo.getSongCasting(created.id)).length === 1,
        "the failed rewrite rolled back: prior casting intact",
    );

    // Atomicity of save_song: a song save whose part rewrite violates a constraint rolls
    // back ENTIRELY -- the title + version claim does not advance and the prior parts survive
    // (vs. the old claim-then-write, which changed the title, bumped the version, and wiped parts).
    const beforeSave = (await repo.getSong(created.id))!;
    const beforeParts = await repo.getSongParts(created.id);
    let saveThrew = false;
    try {
        await repo.updateSong(
            created.id,
            {
                song: { ...created, title: "Should Roll Back" },
                arranger: null,
                chartRef: null,
                lastRehearsed: null,
                startPitch: null,
                parts: [
                    {
                        label: "Bad",
                        isRequired: true,
                        countNeeded: 0,
                        voicePartId: null,
                        isSolo: true,
                        rangeLowMidi: null,
                        rangeHighMidi: null,
                    },
                ], // count_needed=0 violates a CHECK
            },
            beforeSave.version!,
        );
    } catch {
        saveThrew = true;
    }
    assert(saveThrew, "a song save whose part violates a constraint throws");
    const afterSave = (await repo.getSong(created.id))!;
    assert(
        afterSave.version === beforeSave.version,
        "the failed save rolled back: version did not advance",
    );
    assert(
        afterSave.title === beforeSave.title,
        "the failed save rolled back: title unchanged",
    );
    const afterParts = await repo.getSongParts(created.id);
    assert(
        afterParts.length === beforeParts.length &&
            afterParts[0]!.id === beforeParts[0]!.id,
        "the failed save rolled back: parts intact",
    );

    assert(
        (await repo.setSongStatus(created.id, "archived"))?.status ===
            "archived",
        "setSongStatus archives",
    );
}
