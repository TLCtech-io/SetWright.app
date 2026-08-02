import { redirect } from "next/navigation";
import { dataSource } from "@/lib/env";
import { MOCK_ENSEMBLE_ID } from "@/lib/ensemble";

export const dynamic = "force-dynamic";

// The root is just a doorway into the active ensemble. The Dashboard is the home inside it.
// Mock mode has no real tenancy, so it lands on the placeholder ensemble; supabase mode
// resolves the user's active (or first) ensemble, falling back to the manage hub when a
// fresh account has none yet.
export default async function Home() {
    if (dataSource !== "supabase") redirect(`/e/${MOCK_ENSEMBLE_ID}/dashboard`);
    const { getActiveEnsembleId, listMyEnsembles } =
        await import("@/lib/ensembles");
    const active = await getActiveEnsembleId();
    // The URL carries the ensemble's public token; the active id is the internal uuid. Resolve the
    // token from the membership list before redirecting into the ensemble.
    const token = active
        ? (await listMyEnsembles()).find((e) => e.id === active)?.publicId
        : null;
    redirect(token ? `/e/${token}/dashboard` : "/ensembles");
}
