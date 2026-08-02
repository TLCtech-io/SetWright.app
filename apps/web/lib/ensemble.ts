// The active-ensemble selection. A single login can belong to several ensembles; the
// one currently in view is held in this cookie, kept in sync with the /e/:id URL by the
// proxy and changed by the switcher. Server pages read it through getRepository() to scope
// their queries. Every /api/e/:ensembleId handler resolves the ensemble from its own URL
// instead, so a stale tab cannot send a write to the wrong ensemble.

import { SECURE_COOKIES } from "./cookies";

export const ACTIVE_ENSEMBLE_COOKIE = "active_ensemble";

// Attributes for writing the active-ensemble cookie, shared by every site that sets it (the
// proxy, the switcher, ensemble creation) so they never drift. Secure in production so the
// tenancy selection is never sent over plaintext, from the same constant the auth session
// cookies now use; SameSite=Lax keeps it off cross-site requests.
export const ACTIVE_ENSEMBLE_COOKIE_OPTIONS = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: SECURE_COOKIES,
};

// Mock mode has no real ensembles (the in-memory store ignores tenancy), but the page
// routes still live under /e/:ensembleId. This stable placeholder fills the segment so
// the URLs are well-formed; the proxy is a pass-through in mock mode, so it is never
// validated, and the mock repository ignores it.
export const MOCK_ENSEMBLE_ID = "mock";

// One of the ensembles a login belongs to. Client-safe (no server-only imports), so
// both the server helpers and the switcher/hub Client Components can share the shape.
// `id` is the internal uuid (scoping, the active_ensemble cookie); `publicId` is the URL
// token the switcher navigates to (/e/:publicId). Both are present, never interchangeable.
export interface MyEnsemble {
    id: string;
    name: string;
    role: "director" | "section_leader" | "member";
    publicId: string;
}
