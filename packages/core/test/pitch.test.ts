// Pitch and key labels. The math lives in pitch.ts; this pins the display
// spelling so the client can render keys without redoing the conversion.

import assert from 'node:assert';
import { keyLabel, midi, noteName, tonicName, tonicPitchClass } from '../src/pitch.js';

// Sharp key spells with sharps.
assert.equal(keyLabel({ fifths: 2, mode: 'major' }), 'D major');
assert.equal(keyLabel({ fifths: 6, mode: 'major' }), 'F# major');

// Flat key spells with flats, not the enharmonic sharp.
assert.equal(keyLabel({ fifths: -2, mode: 'major' }), 'Bb major');
assert.equal(keyLabel({ fifths: -3, mode: 'major' }), 'Eb major');

// C major and its relative A minor at the empty signature.
assert.equal(keyLabel({ fifths: 0, mode: 'major' }), 'C major');
assert.equal(keyLabel({ fifths: 0, mode: 'minor' }), 'A minor');

// A minor key carries the mode word.
assert.equal(keyLabel({ fifths: 1, mode: 'minor' }), 'E minor');

// The label agrees with the tonic math it is built on.
assert.equal(tonicPitchClass({ fifths: 0, mode: 'minor' }), 9); // A

// noteName is the inverse of midi: middle C round-trips, accidentals spell sharp.
assert.equal(noteName(60), 'C4');
assert.equal(noteName(midi('A2')), 'A2');
assert.equal(noteName(midi('Bb3')), 'A#3'); // sharp spelling on the way back
assert.equal(midi(noteName(45)), 45);
assert.equal(noteName(0), 'C-1'); // the MIDI floor

// tonicName: the spelled tonic, no mode word, no octave; flats for flat keys.
assert.equal(tonicName({ fifths: 0, mode: 'major' }), 'C');
assert.equal(tonicName({ fifths: 0, mode: 'minor' }), 'A'); // relative minor at the empty signature
assert.equal(tonicName({ fifths: -2, mode: 'major' }), 'Bb'); // flat key spells flat
assert.equal(tonicName({ fifths: 2, mode: 'major' }), 'D');
assert.equal(tonicName({ fifths: 6, mode: 'major' }), 'F#'); // sharp key spells sharp

// The three enharmonic signatures at the bottom of the circle each spell two
// ways, and both spellings are offered so a chart matches its own notation.
// Each pair reads flat-side then sharp-side, major then relative minor.

// 7 flats / 5 sharps.
assert.equal(keyLabel({ fifths: -7, mode: 'major' }), 'Cb major'); // not the pitch-class name "B major"
assert.equal(keyLabel({ fifths: 5, mode: 'major' }), 'B major');
assert.equal(keyLabel({ fifths: -7, mode: 'minor' }), 'Ab minor'); // relative minor of Cb major
assert.equal(keyLabel({ fifths: 5, mode: 'minor' }), 'G# minor'); // relative minor of B major

// 6 flats / 6 sharps.
assert.equal(keyLabel({ fifths: -6, mode: 'major' }), 'Gb major');
assert.equal(keyLabel({ fifths: 6, mode: 'major' }), 'F# major');
assert.equal(keyLabel({ fifths: -6, mode: 'minor' }), 'Eb minor');
assert.equal(keyLabel({ fifths: 6, mode: 'minor' }), 'D# minor');

// 5 flats / 7 sharps.
assert.equal(keyLabel({ fifths: -5, mode: 'major' }), 'Db major');
assert.equal(keyLabel({ fifths: 7, mode: 'major' }), 'C# major');
assert.equal(keyLabel({ fifths: -5, mode: 'minor' }), 'Bb minor');
assert.equal(keyLabel({ fifths: 7, mode: 'minor' }), 'A# minor');

// Every standard signature (-7..7, both modes) spells with one letter and at
// most a single accidental, and each half of an enharmonic pair keeps its own
// distinct label. This is the full set the song form now offers: 15 distinct
// major spellings and 15 distinct minor spellings, no collisions at the corners.
const seenMajor = new Set<string>();
const seenMinor = new Set<string>();
for (let f = -7; f <= 7; f++) {
  for (const mode of ['major', 'minor'] as const) {
    const label = keyLabel({ fifths: f, mode });
    assert.match(label, /^[A-G][#b]? (major|minor)$/, `unexpected key label: ${label}`);
  }
  seenMajor.add(tonicName({ fifths: f, mode: 'major' }));
  seenMinor.add(tonicName({ fifths: f, mode: 'minor' }));
}
assert.equal(seenMajor.size, 15); // 15 major signatures, 15 distinct spellings
assert.equal(seenMinor.size, 15); // 15 relative-minor signatures, 15 distinct spellings

console.log('pitch.test.ts: all assertions passed');
