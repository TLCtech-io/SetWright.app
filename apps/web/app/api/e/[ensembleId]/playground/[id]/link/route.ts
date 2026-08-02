import { NextResponse } from "next/server";
import { badPathUuid, repoForRoute } from "@/lib/apiEnsemble";

type Params = { params: Promise<{ ensembleId: string; id: string }> };

// Seed a real event setlist from a saved program, so the director can check the
// fixed program against an event's availability and coverage.
export async function POST(req: Request, { params }: Params) {
    const { ensembleId, id } = await params;
    const bad = badPathUuid(id);
    if (bad) return bad;
    const repo = await repoForRoute(ensembleId, { requireDirector: true });
    if (repo instanceof NextResponse) return repo;
    const raw = await req.json().catch(() => null);
    const eventId =
        raw &&
        typeof raw === "object" &&
        typeof (raw as Record<string, unknown>).eventId === "string"
            ? (raw as Record<string, string>).eventId
            : "";
    const events = await repo.listEvents();
    if (!eventId || !events.some((e) => e.id === eventId)) {
        return NextResponse.json({ error: "unknown event" }, { status: 400 });
    }
    const meta = await repo.createSetlistFromPlayground(id, eventId);
    if (!meta) {
        return NextResponse.json(
            { error: "program or event not found" },
            { status: 404 },
        );
    }
    return NextResponse.json(
        { setlistId: meta.id, publicId: meta.publicId },
        { status: 201 },
    );
}
