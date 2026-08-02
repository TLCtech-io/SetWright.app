// Where a non-director member is sent when they land on a director-only console page.
// Extracted from the session proxy's inline role gate so the decision is pure and unit-tested.
// The proxy checks the tier and issues the redirect; this only computes the target.
//
// A member's own surface lives under /e/:ensemble/me. Every other console page bounces them
// there, with one exception: the event-detail page /e/:ensemble/events/:eventToken is a shared,
// role-branched route (director: setlist manager; member: read-only call sheet), so a member is
// not bounced from it. The exception is exact. The segment after events/ must BE a public_id
// token and nothing deeper, so it admits the detail page alone, not the events list, not the
// reserved /events/new, not /events/:id/roster.

import { PUBLIC_ID_RE } from "./publicId";

/** The bounce target for a non-director on `path`, or null when the path is member-allowed. */
export function memberBounceTarget(
    path: string,
    ensembleSegment: string,
): string | null {
    const meBase = `/e/${ensembleSegment}/me`;
    if (path === meBase || path.startsWith(`${meBase}/`)) return null;
    const eventsBase = `/e/${ensembleSegment}/events/`;
    const afterEvents = path.startsWith(eventsBase)
        ? path.slice(eventsBase.length)
        : null;
    if (afterEvents !== null && PUBLIC_ID_RE.test(afterEvents)) return null;
    return meBase;
}
