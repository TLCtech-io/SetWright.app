// A sanitized data-layer error. The raw Supabase / PostgREST error — which can name
// tables, policies, columns, and functions — is kept as `cause` for server logs only;
// the message is generic, so nothing about the schema leaks through an HTTP boundary
// that reflects an error or through aggregated logs. (Next already hides 500 messages
// from clients in production; this is the belt to that suspenders, and keeps the raw
// detail structured under `cause` for debugging.)

export function dbError(cause: unknown): Error {
    return new Error("A database request failed.", { cause });
}
