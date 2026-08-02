// Coerce an untrusted invite payload into a clean, lowercased email. Deliberately
// permissive on shape (one @ with a dotted domain, length-capped) — GoTrue does the
// authoritative validation when the invite is actually sent; this just rejects the
// obviously-malformed before we touch the database.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Result = { ok: true; value: string } | { ok: false; error: string };

export function coerceInviteEmail(raw: unknown): Result {
    const r = (raw ?? {}) as Record<string, unknown>;
    const email =
        typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
    if (!email) return { ok: false, error: "an email is required" };
    if (email.length > 254 || !EMAIL_RE.test(email)) {
        return { ok: false, error: "enter a valid email address" };
    }
    return { ok: true, value: email };
}
