// Coerce an untrusted accept/decline payload into a clean ensemble id.
//
// The id names WHICH invitation the caller is acting on. It does not grant anything: both RPCs key
// on auth.email() and treat this argument only as a narrowing filter, so a wrong or invented id
// selects nothing rather than reaching someone else's invitation. The shape check is here so a
// malformed body is a clean 400 instead of a Postgres cast error surfacing as a 500.

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result = { ok: true; value: string } | { ok: false; error: string };

export function coerceInvitationTarget(raw: unknown): Result {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.ensembleId === "string" ? r.ensembleId.trim() : "";
    if (!id) return { ok: false, error: "an ensembleId is required" };
    if (!UUID_RE.test(id))
        return { ok: false, error: "ensembleId must be a uuid" };
    return { ok: true, value: id };
}
