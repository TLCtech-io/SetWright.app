import Link from "next/link";
import { redirect } from "next/navigation";
import { dataSource } from "@/lib/env";
import {
    canFoundEnsemble,
    getActiveEnsembleId,
    listMyEnsembles,
} from "@/lib/ensembles";
import { EnsemblesManager } from "@/components/EnsemblesManager";
import { AuthBar } from "@/components/AuthBar";

export const dynamic = "force-dynamic";

export default async function EnsemblesPage() {
    // Mock mode is single-ensemble; there is nothing to manage.
    if (dataSource !== "supabase") redirect("/");
    const ensembles = await listMyEnsembles();
    const active = await getActiveEnsembleId();
    // Founding a new ensemble needs a credit (invite-first). Hide the create form for a member who has
    // none, rather than showing a form whose submit would be refused.
    const canFound = await canFoundEnsemble();
    // This page is a detour off the nav. When they already have an active ensemble, offer a way
    // back into it — without this, a mis-click strands them here with no return path. The URL
    // carries the public token, so resolve it (and the name) from the membership list.
    const activeEnsemble = active
        ? ensembles.find((e) => e.id === active)
        : undefined;
    const activeName = activeEnsemble?.name;
    const activeToken = activeEnsemble?.publicId;

    return (
        <>
            {/* The one signed-in page with no ensemble nav — so it carries the account bar,
          mounted as chrome above the content column like the nav. */}
            <AuthBar />
            <main className="page ensembles-page">
                {activeToken && (
                    <Link
                        href={`/e/${activeToken}/dashboard`}
                        className="back-link"
                    >
                        &larr; Back to {activeName ?? "dashboard"}
                    </Link>
                )}
                <div className="page-head">
                    <div>
                        <h1>Your ensembles</h1>
                        <div className="sub">
                            Switch between the ensembles you belong to, or start
                            a new one.
                        </div>
                    </div>
                </div>
                <EnsemblesManager
                    ensembles={ensembles}
                    active={active}
                    canFound={canFound}
                />
            </main>
        </>
    );
}
