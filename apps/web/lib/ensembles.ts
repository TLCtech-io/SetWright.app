// Cross-ensemble, server-side operations that sit OUTSIDE the per-ensemble Repository:
// listing the ensembles a login belongs to and resolving the active one. Reads only;
// the cookie is written by the switch / create route handlers.

import "server-only";
import { cookies } from "next/headers";
import { dataSource } from "./env";
import * as db from "./db";
import { ACTIVE_ENSEMBLE_COOKIE, type MyEnsemble } from "./ensemble";
import { isPublicId } from "./publicId";
import { serverClient } from "./supabase/server";

export type { MyEnsemble };

/** The signed-in user's own membership in one ensemble — the "who am I here" + tier. */
export interface MyMembership {
    memberId: string;
    tier: MyEnsemble["role"];
    displayName: string;
}

/**
 * The caller's membership (id, tier, name) in the ensemble named by `ensembleToken` (the
 * /e/:ensemble URL segment, a public_id), or null if they don't actively belong. The single
 * source of truth for role-gating the UI (layout/nav) and for resolving "my own member row" in
 * the self-service pages. In mock mode there is no auth, so the lone implicit user is the
 * ensemble's director.
 */
export async function getMyMembership(
    ensembleToken: string,
): Promise<MyMembership | null> {
    if (dataSource !== "supabase") {
        // Reuse the one mock-self resolver (honors MOCK_MEMBER_ID) so the tier used to gate the
        // UI matches the identity the self-service reads resolve to.
        const self = db.mockSelf();
        return self
            ? {
                  memberId: self.id,
                  tier: self.role,
                  displayName: self.displayName,
              }
            : null;
    }
    // A malformed token can never name a row, so short-circuit rather than round-trip.
    if (!isPublicId(ensembleToken)) return null;
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    // Resolve the token in the query: !inner makes the public_id filter restrict the member rows to
    // the matching ensemble instead of nulling a left-joined embed.
    const { data } = await supabase
        .from("member")
        .select(
            "id, permission_tier, display_name, ensemble:ensemble_id!inner(public_id)",
        )
        .eq("user_id", user.id)
        .eq("ensemble.public_id", ensembleToken)
        .eq("status", "active")
        .maybeSingle();
    if (!data) return null;
    return {
        memberId: data.id as string,
        tier: data.permission_tier as MyEnsemble["role"],
        displayName: data.display_name as string,
    };
}

/** The ensembles the signed-in user actively belongs to, with their role in each. */
export async function listMyEnsembles(): Promise<MyEnsemble[]> {
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
        .from("member")
        .select("permission_tier, ensemble:ensemble_id(id, name, public_id)")
        .eq("user_id", user.id)
        .eq("status", "active");
    // An archived (or otherwise non-active) ensemble fails ensemble_read RLS, so its embedded row
    // resolves to null even though the member row is still active. Skip those rather than dereference
    // null — they are retired and should not appear in the nav.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? [])
        .filter((m: any) => m.ensemble)
        .map((m: any) => ({
            id: m.ensemble.id,
            name: m.ensemble.name,
            role: m.permission_tier,
            publicId: m.ensemble.public_id,
        }));
}

/**
 * The active ensemble id: the cookie when it names one of the user's ensembles, else
 * their first. null when they belong to none (a fresh account before onboarding).
 */
export async function getActiveEnsembleId(): Promise<string | null> {
    const mine = await listMyEnsembles();
    if (mine.length === 0) return null;
    const cookie = (await cookies()).get(ACTIVE_ENSEMBLE_COOKIE)?.value;
    return cookie && mine.some((e) => e.id === cookie) ? cookie : mine[0]!.id;
}

/**
 * Whether the signed-in user may found a new ensemble: they hold at least one founding credit. In the
 * interim invite-first model a plain member has none (only a platform-admin grant, or the free-tier
 * future, gives one), so the create form is hidden for them. A self-row read — a user can see their own
 * credit. Mock mode has no gating.
 */
export async function canFoundEnsemble(): Promise<boolean> {
    if (dataSource !== "supabase") return true;
    const supabase = await serverClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase
        .from("app_user")
        .select("founding_credits")
        .eq("id", user.id)
        .maybeSingle();
    return ((data?.founding_credits as number | undefined) ?? 0) > 0;
}
