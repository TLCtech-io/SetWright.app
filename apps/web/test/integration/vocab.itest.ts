// Vocabularies (tags, voice parts, padding profiles, event types) + roster.
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    const { repo } = await signInAs("ana@example.com");

    // Tags
    const tags = await repo.listTags();
    assert(
        tags.length === 5 && tags[0]!.sortOrder === 0,
        "listTags ordered, 5 of them",
    );
    const gospel = tags.find((t) => t.name === "gospel")!;
    assert(
        (await repo.tagUsage())[gospel.id]!.songs === 2,
        "gospel used by 2 songs",
    );
    assert(
        (await repo.createTag({ name: "Gospel", category: "genre" })).ok ===
            false,
        "createTag rejects case-insensitive duplicate",
    );
    const tag = await repo.createTag({ name: "jazz", category: "genre" });
    assert(tag.ok, "createTag adds");
    if (tag.ok) {
        assert(
            (
                await repo.updateTag(tag.tag.id, {
                    name: "swing",
                    category: "mood",
                })
            ).ok,
            "updateTag renames",
        );
        assert((await repo.deleteTag(tag.tag.id)).ok, "deleteTag");
    }

    // Voice parts
    const vps = await repo.listVoiceParts();
    const bass = vps.find((v) => v.label === "Bass")!;
    const vu = (await repo.voicePartUsage())[bass.id]!;
    assert(
        vu.parts === 5 && vu.members === 1,
        "voicePartUsage counts parts + members",
    );
    const inUse = await repo.deleteVoicePart(bass.id);
    assert(
        !inUse.ok && inUse.reason === "in-use",
        "deleteVoicePart refuses a section a chart needs",
    );
    const vp = await repo.createVoicePart({
        label: "Baritone",
        isPitched: true,
        nominalLowMidi: 45,
        nominalHighMidi: 64,
    });
    assert(
        vp.ok && (await repo.deleteVoicePart(vp.voicePart.id)).ok,
        "create + delete an unused section",
    );

    // Padding profiles + event types
    const pps = await repo.listPaddingProfiles();
    const concertPp = pps.find((p) => p.name === "Concert")!;
    assert(
        (await repo.paddingProfileUsage())[concertPp.id]!.eventTypes === 1,
        "Concert profile used by 1 type",
    );
    const ets = await repo.listEventTypes();
    const concertEt = ets.find((e) => e.name === "Concert")!;
    assert(
        (await repo.eventTypeUsage())[concertEt.id]!.events === 1,
        "Concert type used by 1 event",
    );
    const preset = await repo.resolveEventTypePreset(concertEt.id);
    assert(
        preset?.perSongSeconds === 30 &&
            preset?.perSetSeconds === 90 &&
            preset?.allowsOnBook === true,
        "preset resolves padding + policy",
    );
    assert(
        Object.keys(await repo.eventTypePresets()).length === 2,
        "eventTypePresets covers all types",
    );
    const et = await repo.createEventType({
        name: "Competition",
        paddingProfileId: concertPp.id,
        defaultAllowsOnBook: false,
        defaultAllowsExplicit: false,
        defaultAllowsAccompaniment: true,
        excludeTags: ["ballad"],
        preferTags: ["gospel", "ballad"],
        requireTags: [],
    });
    assert(
        et.ok &&
            et.eventType.excludeTags.join() === "ballad" &&
            et.eventType.preferTags.join() === "gospel",
        "event-type tag rules exclude-wins",
    );
    if (et.ok) await repo.deleteEventType(et.eventType.id);
    const pp = await repo.createPaddingProfile({
        name: "Temp",
        perSongSeconds: 10,
        perSetSeconds: 20,
    });
    if (pp.ok) {
        const etRef = await repo.createEventType({
            name: "UsesTemp",
            paddingProfileId: pp.profile.id,
            defaultAllowsOnBook: false,
            defaultAllowsExplicit: false,
            defaultAllowsAccompaniment: true,
            excludeTags: [],
            preferTags: [],
            requireTags: [],
        });
        assert(
            (await repo.deletePaddingProfile(pp.profile.id)).ok,
            "deletePaddingProfile clears its types",
        );
        if (etRef.ok) {
            assert(
                (await repo.resolveEventTypePreset(etRef.eventType.id))
                    ?.perSongSeconds === 30,
                "type falls back to DEFAULT_PADDING after profile delete",
            );
            await repo.deleteEventType(etRef.eventType.id);
        }
    }

    // Members
    const roster = await repo.listRoster();
    assert(
        (await repo.listMembers()).length === 4 && roster.length === 4,
        "4 active singing members; roster scoped to ensemble A",
    );
    const ana = roster.find((m) => m.displayName === "Ana")!;
    assert(
        ana.role === "director" && ana.sections.some((s) => s.isPrimary),
        "Ana is director with a home section",
    );
    assert(
        roster.find((m) => m.displayName === "Cleo")!.sections.length === 2,
        "Cleo has 2 sections",
    );
    const demote = await repo.updateMember(ana.id, {
        displayName: "Ana",
        role: "member",
        singing: true,
        sections: ana.sections,
        rangeLowMidi: null,
        rangeHighMidi: null,
    });
    assert(
        !demote.ok && demote.reason === "last-director",
        "updateMember blocks demoting the last director",
    );
    assert(
        (
            await repo.createMember({
                displayName: "Eli",
                role: "member",
                singing: true,
                sections: [{ voicePartId: bass.id, isPrimary: true }],
                rangeLowMidi: 40,
                rangeHighMidi: 60,
            })
        ).sections.length === 1,
        "createMember with a section",
    );
    const cleo = roster.find((m) => m.displayName === "Cleo")!;
    const wade = (await repo.listSongs()).find((s) =>
        s.title.startsWith("Wade"),
    )!;
    const before = (await repo.getSongCasting(wade.id)).length;
    assert(
        (await repo.setMemberStatus(cleo.id, "inactive")).ok,
        "setMemberStatus deactivates",
    );
    assert(
        (await repo.getSongCasting(wade.id)).length === before - 1,
        "deactivation prunes the member’s casting",
    );
}
