import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; setlistId: string }> };

// Clone a performed set into a fresh draft on a target event, so a past program is
// a starting point.
export async function POST(req: Request, { params }: Params) {
    const { ensembleId, setlistId } = await params;
    const bad = badPathUuid(setlistId);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const targetEventId =
        raw &&
        typeof raw === "object" &&
        typeof (raw as Record<string, unknown>).targetEventId === "string"
            ? (raw as Record<string, string>).targetEventId
            : "";
    const events = await repo.listEvents();
    if (!targetEventId || !events.some((e) => e.id === targetEventId)) {
        return NextResponse.json({ error: "unknown event" }, { status: 400 });
    }
    const meta = await repo.cloneSetlist(setlistId, targetEventId);
    if (!meta) {
        return NextResponse.json(
            { error: "setlist not found or not performed" },
            { status: 404 },
        );
    }
    return NextResponse.json(
        { setlistId: meta.id, publicId: meta.publicId },
        { status: 201 },
    );
}
