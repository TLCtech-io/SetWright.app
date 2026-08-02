// The URL-facing public identifier for a routable row. The database stores an opaque,
// unguessable token (public_id) alongside the internal uuid; the URL carries the token so an
// internal id never leaks into a shareable link. The uuid stays the join key below the routing
// layer: the active_ensemble cookie, RLS, and every foreign key are all uuid, unchanged.
//
// Format: base64url of 16 random bytes, padding stripped, so exactly 22 chars. gen_public_id() in
// the ...050 migration is the database generator (the column default); this module is the
// app-layer validator plus a matching generator for a code path that mints an id before a round
// trip. No node:crypto import, so this stays safe to pull into the session proxy (the middleware
// bundle) through ensemblePath.ts -- it uses the Web Crypto global, present in both runtimes.

/** A public_id is exactly 22 base64url characters: A-Z a-z 0-9 - _. */
export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** True when `value` is shaped like a public_id token. */
export function isPublicId(value: string): boolean {
    return PUBLIC_ID_RE.test(value);
}

/** Mint a public_id: base64url of 16 random bytes, padding stripped (22 chars). */
export function genPublicId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
