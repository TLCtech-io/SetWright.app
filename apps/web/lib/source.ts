// The data-source seam for the @repertoire/api RPC contract (draft / locks).
// Routes ask for a source and never learn whether it is reading the mock or
// Supabase. The parallel seam for the direct CRUD surface is getRepository() in
// lib/repository.ts; both pick the backend off DATA_SOURCE. (Performing a set is a
// CRUD-surface write — Repository.markPerformed -> perform_setlist — not part of
// this read contract.)

import type { HydrationSource, LocksSource } from "@repertoire/api";
import { getLocks, hydratePayload } from "./db";
import { dataSource } from "./env";
import { dbError } from "./supabase/errors";
import { serverClient } from "./supabase/server";

type Source = HydrationSource & LocksSource;

// SUPABASE source. The two SQL functions were shaped to match the api contract
// (hydrate_draft_input -> DraftInput, hydrate_setlist_locks -> the pins/segues/
// breaks), so each method is a thin RPC call on the signed-in user's RLS-scoped
// client. A null/empty hydrate yields {}, which the endpoints' isHydrated guard
// turns into a 404, same as the mock.
function supabaseSource(): Source {
    return {
        hydrate: async (eventId) => {
            const supabase = await serverClient();
            const { data, error } = await supabase.rpc("hydrate_draft_input", {
                p_event: eventId,
            });
            if (error) throw dbError(error);
            return data ?? {};
        },
        hydrateLocks: async (setlistId) => {
            const supabase = await serverClient();
            const { data, error } = await supabase.rpc(
                "hydrate_setlist_locks",
                { p_setlist: setlistId },
            );
            if (error) throw dbError(error);
            return data;
        },
    };
}

// MOCK source over the in-memory db. hydrate projects the event's pool;
// hydrateLocks reads the setlist's pins. An unknown event id yields a payload with
// no `event`, which the endpoints' isHydrated guard turns into a real 404.
function mockSource(): Source {
    return {
        hydrate: async (eventId) => hydratePayload(eventId) ?? {},
        hydrateLocks: async (setlistId) => getLocks(setlistId),
    };
}

export function getSource(): Source {
    return dataSource === "supabase" ? supabaseSource() : mockSource();
}
