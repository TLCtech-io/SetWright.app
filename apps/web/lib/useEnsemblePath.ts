"use client";

import { usePathname } from "next/navigation";

// The `/e/:ensembleId` prefix for the page currently in view, derived from the URL so
// Client Components can build in-app links without threading the id through props. Pages
// live at /e/:ensembleId/... → splitting on '/' gives ['', 'e', ':id', ...]. Returns ''
// when not under an ensemble route (so callers degrade to root-relative links).
export function useEnsemblePrefix(): string {
    const parts = usePathname().split("/");
    return parts[1] === "e" && parts[2] ? `/e/${parts[2]}` : "";
}
