// Tenant isolation + confidence privacy, exercised through the adapter as the
// non-director member (Ben) and the other ensemble's director (Rae).
import { assert, signInAs } from "./helpers";

export async function run(): Promise<void> {
    // Ben — a member of ensemble A, not a director and not the cast singer.
    const benAuth = await signInAs("ben@example.com");
    const ben = benAuth.repo;
    const benSongs = await ben.listSongs();
    assert(benSongs.length === 5, "Ben sees ensemble A repertoire (5), not B");
    const grave = benSongs.find((s) => s.title.startsWith("Ain't No Grave"))!;
    const gLead = (await ben.getSongCasting(grave.id)).find(
        (c) => c.isPrimary,
    )!;
    assert(
        gLead.confidence === null,
        "private ensemble: a peer sees null self-reported confidence",
    );
    assert(
        gLead.directorAssessed === null,
        "a non-director never sees director_assessed",
    );

    // getEnsembleCoverage (the N+1 batching): the ONE ensemble-wide read must stay tenant-scoped and
    // apply the SAME confidence masking as the per-song getSongCasting it replaces. A wider query is
    // exactly where a cross-tenant leak or an unmasked self-report could slip in.
    const benCov = await ben.getEnsembleCoverage();
    const aSongIds = new Set(benSongs.map((s) => s.id));
    assert(benCov.parts.length > 0, "batched coverage returns A parts");
    assert(
        benCov.parts.every((p) => aSongIds.has(p.songId)),
        "batched coverage: every part belongs to an A song (tenant-scoped)",
    );
    const graveLeadCov = benCov.castings.find(
        (c) => c.partId === gLead.partId && c.memberId === gLead.memberId,
    );
    assert(
        !!graveLeadCov && graveLeadCov.confidence === null,
        "batched coverage masks a peer self-report, like the per-song read",
    );

    // Rae — director of ensemble B. Must see only B's repertoire.
    const raeAuth = await signInAs("rae@example.com");
    const rae = raeAuth.repo;
    const raeSongs = await rae.listSongs();
    assert(raeSongs.length === 2, "Rae sees only ensemble B repertoire (2)");
    assert(
        raeSongs
            .map((s) => s.title)
            .sort()
            .join(",") === "Shenandoah,The Water Is Wide",
        "isolation holds both directions",
    );

    // Cross-tenant setlist isolation. A's performed set is member-visible WITHIN A, but a director of B
    // must not read its rows via a raw, ensemble-unfiltered query — the setlist RLS policy scopes
    // published/performed visibility to the member's own tenant, so it never matches across tenants.
    let aPerformedSetId: string | null = null;
    for (const e of await ben.listEvents({ kind: "gig" })) {
        const perf = (await ben.listEventSetlists(e.id)).find(
            (m) => m.status === "performed",
        );
        if (perf) {
            aPerformedSetId = perf.id;
            break;
        }
    }
    assert(
        aPerformedSetId !== null,
        "ensemble A has a performed setlist in the seed",
    );
    // A member of A reads it — in-tenant, performed = visible.
    const benSees = await ben.getPublishedSet(aPerformedSetId!);
    assert(
        !!benSees && benSees.songs.length > 0,
        "a member of A reads A performed set (in-tenant)",
    );
    // B's director, querying raw (no ensemble filter, so only RLS gates it), sees nothing. Assert no
    // error too, so a broken query fails loudly instead of an errored `data: null` reading as zero rows.
    const setlistLeak = await raeAuth.client
        .from("setlist")
        .select("id")
        .eq("id", aPerformedSetId!);
    assert(
        setlistLeak.error == null && (setlistLeak.data ?? []).length === 0,
        "cross-tenant: B cannot read A setlist row",
    );
    const itemLeak = await raeAuth.client
        .from("setlist_item")
        .select("id")
        .eq("setlist_id", aPerformedSetId!);
    assert(
        itemLeak.error == null && (itemLeak.data ?? []).length === 0,
        "cross-tenant: B cannot read A setlist_item rows",
    );
}
