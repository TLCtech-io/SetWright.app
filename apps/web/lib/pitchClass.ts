// The shape of a "pitch to blow": a pitch class like 'C#', 'Eb', or 'A' — a
// letter A-G with an optional accidental, no octave. One home for the grammar,
// shared by the form's client guard and the server coercer, and mirrored by the
// schema check on song.start_pitch. Dependency-free so the client can import it
// without pulling in the mock db.
//
// Returns the normalized pitch (letter upper-cased, accidental kept) or null when
// empty or malformed.
export function pitchClassOrNull(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const m = /^([A-Ga-g])([#b]?)$/.exec(v.trim());
    if (!m) return null;
    return `${m[1]!.toUpperCase()}${m[2] ?? ""}`;
}
