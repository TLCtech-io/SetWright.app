// The Supabase adapter for the hydration source. Typed against the minimal rpc
// surface, so this package takes no supabase-js dependency: a real
// SupabaseClient satisfies it structurally.

import type { ID } from "@repertoire/core";
import type { HydrationSource, LocksSource } from "./types.js";

/**
 * The slice of a Supabase client this needs: rpc returning { data, error }.
 * Pass the signed-in user's client, never the service-role key, or the
 * RLS-scoped tenancy at the SQL boundary is gone.
 */
export interface SupabaseRpcClient {
    rpc(
        fn: string,
        args: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// Wrap an rpc failure in a generic message, keeping the raw database error as `cause` for
// server-side logging. The database message is never interpolated into the thrown Error:
// this adapter is exported, so a caller may surface the message to a client, and a raw DB
// error can leak schema or internal detail.
function rpcError(operation: string, cause: unknown): Error {
    return new Error(`${operation} failed`, { cause });
}

export function supabaseHydrationSource(
    client: SupabaseRpcClient,
): HydrationSource & LocksSource {
    return {
        async hydrate(eventId: ID): Promise<unknown> {
            const { data, error } = await client.rpc("hydrate_draft_input", {
                p_event: eventId,
            });
            if (error) {
                throw rpcError("draft hydration", error);
            }
            return data;
        },
        async hydrateLocks(setlistId: ID): Promise<unknown> {
            const { data, error } = await client.rpc("hydrate_setlist_locks", {
                p_setlist: setlistId,
            });
            if (error) {
                throw rpcError("setlist locks hydration", error);
            }
            return data;
        },
    };
}
