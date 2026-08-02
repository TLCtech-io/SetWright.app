// The one home for pitch and key conversion. Pitch is MIDI, middle C = 60.
// Key is fifths plus mode. No conversion logic lives anywhere else.

import type { KeySig, MidiPitch } from "./types.js";

const NOTE_TO_SEMITONE: Record<string, number> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11,
};

/** Parse scientific pitch notation ("C4", "F#3", "Bb2") to a MIDI number. */
export function midi(spn: string): MidiPitch {
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(spn.trim());
    if (!m) throw new Error(`bad pitch: ${spn}`);
    const letter = m[1]!.toUpperCase();
    const accidental = m[2]!;
    const octave = parseInt(m[3]!, 10);
    let semis = NOTE_TO_SEMITONE[letter]!;
    if (accidental === "#") semis += 1;
    if (accidental === "b") semis -= 1;
    return semis + (octave + 1) * 12; // C-1 = 0, so C4 = 60
}

/**
 * Pitch class (0-11) of a key's tonic. Major tonic is (7 * fifths) mod 12, the
 * circle-of-fifths position folded into an octave. Minor sits three fifths up
 * from the relative major, so add 9 (which is -3 mod 12). C major / A minor at
 * fifths 0 both resolve through their own mode: C major -> 0, A minor -> 9.
 */
export function tonicPitchClass(key: KeySig): number {
    const raw = key.mode === "major" ? 7 * key.fifths : 7 * key.fifths + 9;
    return ((raw % 12) + 12) % 12;
}

// Sharp spelling table for a MIDI pitch label ("G#3"). Note names only. Key
// tonics spell off the line of fifths in tonicName, not from this table, so a
// key can read the enharmonic the pitch class alone cannot (Gb vs F#, Cb vs B).
const SHARP_NAMES = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
];

/**
 * MIDI number to scientific pitch notation, sharp spelling ("G#3"). The inverse
 * of midi(), and the one place that reverse conversion lives. middle C (60) -> C4.
 */
export function noteName(pitch: MidiPitch): string {
    const pc = ((pitch % 12) + 12) % 12;
    const octave = Math.floor(pitch / 12) - 1;
    return `${SHARP_NAMES[pc]!}${octave}`;
}

/**
 * A human key label like "G major" or "Bb minor". The tonic comes from
 * tonicName, which spells off the line of fifths; this only appends the mode.
 * The client renders this; it does not redo the conversion.
 */
export function keyLabel(key: KeySig): string {
    return `${tonicName(key)} ${key.mode}`;
}

// Letters around the line of fifths, one step sharpward each. C sits at index 1,
// so a tonic at line-of-fifths position p takes FIFTHS_LETTERS[(p + 1) mod 7].
const FIFTHS_LETTERS = "FCGDAEB";

/**
 * The spelled tonic of a key, no mode word and no octave: "C", "Bb", "F#", "Gb".
 * Spelled from the key's line-of-fifths position, so the letter and accidental
 * track the signature itself. That is what separates the enharmonic keys a
 * signature can name: 6 flats reads "Gb" and 6 sharps reads "F#"; 7 flats reads
 * "Cb", not "B". keyLabel builds on this, and a running-order sheet shows it as
 * the pitch to blow when a song sets no explicit one.
 */
export function tonicName(key: KeySig): string {
    const pos = tonicPosition(key);
    const letter = FIFTHS_LETTERS[(((pos + 1) % 7) + 7) % 7]!;
    const shift = Math.floor((pos + 1) / 7); // sharps if positive, flats if negative
    const accidental = shift > 0 ? "#".repeat(shift) : "b".repeat(-shift);
    return letter + accidental;
}

// Key geometry for the seam cost. The line of fifths is the unwrapped circle:
// adjacent keys (a fifth apart) sit one step apart, distant keys sit far. This
// is the home for it, so the sequencer's cost term imports rather than redefines.

/**
 * Position of the tonic on the unwrapped line of fifths. Major sits at the
 * signature value. Minor sits three steps sharp, since A minor's tonic is 3
 * fifths from C while sharing C major's empty signature.
 */
export function tonicPosition(key: KeySig): number {
    return key.mode === "major" ? key.fifths : key.fifths + 3;
}

/** 0..6. Steps around the circle of fifths between two tonics, the shorter way. */
export function circleDistance(a: KeySig, b: KeySig): number {
    const raw = Math.abs(tonicPosition(a) - tonicPosition(b)) % 12;
    return Math.min(raw, 12 - raw);
}

/** Relative major/minor share a signature: same fifths, opposite mode. */
export function isRelativePair(a: KeySig, b: KeySig): boolean {
    return a.fifths === b.fifths && a.mode !== b.mode;
}

/**
 * Tonal direction of a move on the circle of fifths. Sharp-ward (+1) tends to
 * brighten and lift, flat-ward (-1) tends to settle. 0 for same tonic or a
 * tritone, where direction is ambiguous. A convention, not a law.
 */
export function keyDirection(from: KeySig, to: KeySig): -1 | 0 | 1 {
    const delta = tonicPosition(to) - tonicPosition(from);
    const signed = ((((delta + 6) % 12) + 12) % 12) - 6; // -6..5
    if (signed === 0 || signed === -6) return 0;
    return signed > 0 ? 1 : -1;
}
