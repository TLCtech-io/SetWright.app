import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { dataSource } from "@/lib/env";
import { serverClient } from "@/lib/supabase/server";
import { getMyMembership, listMyEnsembles } from "@/lib/ensembles";
import type { MyEnsemble } from "@/lib/ensemble";

// The per-ensemble shell. Everything under /e/:ensembleId shares this nav, which is
// ensemble-aware (links stay inside the active ensemble) and role-aware (a member sees
// only their self-service nav). The nav's avatar opens the account menu (identity, the
// ensemble switcher, profile, sign out) — the top-right corner in one control.
export default async function EnsembleLayout({
    children,
    params,
}: {
    children: ReactNode;
    params: Promise<{ ensembleId: string }>;
}) {
    const { ensembleId } = await params;
    const me = await getMyMembership(ensembleId);

    // Account-menu data — only meaningful when signed in (supabase mode). Mock mode has no
    // auth, so the menu falls back to identity + profile with no switcher or sign-out.
    let email: string | null = null;
    let ensembles: MyEnsemble[] = [];
    if (dataSource === "supabase") {
        const supabase = await serverClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();
        email = user?.email ?? null;
        ensembles = await listMyEnsembles();
    }

    return (
        <>
            <Nav
                ensembleId={ensembleId}
                tier={me?.tier ?? "member"}
                displayName={me?.displayName ?? ""}
                email={email}
                ensembles={ensembles}
                activeEnsembleId={ensembleId}
            />
            {children}
        </>
    );
}
