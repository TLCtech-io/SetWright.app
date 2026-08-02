// Coerce an untrusted song-form payload into a clean SongInput. The form posts
// loose JSON; this validates the enums, ranges, and nullables so the db never
// stores a malformed row. Tag names are resolved against the vocabulary; part
// section names against the voice-part vocabulary; range notes via core's pitch.

import { midi } from '@repertoire/core';
import type { AssessedReadiness, BookStatus, KeySig, Tag } from '@repertoire/core';
import type { PartInput, SongInput, VoicePartRow } from './db';
import { pitchClassOrNull } from './pitchClass';
import { MAX_FORM_ITEMS } from './limits';

const READINESS: AssessedReadiness[] = ['performance-ready', 'needs-polish', 'learning', 'dormant'];
const BOOK: BookStatus[] = ['off-book', 'on-book'];
// A part id must be a uuid (an existing part) or absent (a new part). save_song casts the id to
// uuid, so a non-uuid would abort the whole transactional save; treat it as a new part instead,
// matching the old writeParts (which only matched ids against the existing-part set).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Result = { ok: true; value: SongInput } | { ok: false; error: string };

function asKey(v: unknown): KeySig | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const fifths = r.fifths;
  const mode = r.mode;
  if (typeof fifths !== 'number' || !Number.isInteger(fifths) || fifths < -7 || fifths > 7) return null;
  if (mode !== 'major' && mode !== 'minor') return null;
  return { fifths, mode };
}

// Tempo is stored smallint (max 32767) and duration integer; a value past the domain limit would
// survive coercion and overflow the column on save (a raw 500 instead of a clean store). Clamp to a
// sane ceiling, matching the countNeeded clamp below and eventInput's target/padding caps.
const MAX_TEMPO_BPM = 1_000; // generous: real tempos top out near 300
const MAX_DURATION_SECONDS = 86_400; // 24h

function asPosIntCappedOrNull(v: unknown, max: number): number | null {
  // Round BEFORE the positivity test: a fractional 0 < v < 0.5 passes `v > 0` but rounds to 0,
  // which then violates the column's `> 0` CHECK and 500s. Round first, then keep only a
  // positive integer, so a sub-unit value cleanly becomes null (no value) instead of a 0.
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n > 0 ? Math.min(n, max) : null;
}

function asTrimmedOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function dateOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? v : null;
}

function noteOrNull(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const n = midi(v.trim());
    return n >= 0 && n <= 127 ? n : null;
  } catch {
    return null;
  }
}

export function coerceSongInput(raw: unknown, vocab: Tag[], voiceParts: VoicePartRow[]): Result {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'bad body' };
  const r = raw as Record<string, unknown>;
  const sectionIds = new Set(voiceParts.map((v) => v.id));

  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!title) return { ok: false, error: 'title is required' };

  const intensityRaw = r.intensity;
  const intensity =
    typeof intensityRaw === 'number' && intensityRaw >= 1 && intensityRaw <= 5
      ? Math.round(intensityRaw)
      : null;

  const readiness = READINESS.includes(r.assessedReadiness as AssessedReadiness)
    ? (r.assessedReadiness as AssessedReadiness)
    : 'learning';
  const bookStatus = BOOK.includes(r.bookStatus as BookStatus)
    ? (r.bookStatus as BookStatus)
    : 'off-book';

  // Resolve posted names against the vocabulary, embedding a clean {name,category}
  // (the vocab rows may carry an id/sortOrder the song shouldn't store or leak),
  // deduped by name so a song can't carry the same tag twice (the song_tag PK).
  const byName = new Map(vocab.map((t) => [t.name, t]));
  const tags: Tag[] = Array.isArray(r.tags)
    ? [
        ...new Map(
          r.tags
            .slice(0, MAX_FORM_ITEMS)
            .filter((x): x is string => typeof x === 'string')
            .map((name) => byName.get(name))
            .filter((t): t is Tag => t !== undefined)
            .map((t) => [t.name, { name: t.name, category: t.category }] as const),
        ).values(),
      ]
    : [];

  const partsRaw = Array.isArray(r.parts) ? r.parts.slice(0, MAX_FORM_ITEMS) : [];
  const parts: PartInput[] = [];
  for (const p of partsRaw) {
    // A non-object part is a malformed payload — reject rather than silently drop it before the
    // full parts replacement (a partial apply would delete the omitted parts). A blank-label row is
    // an intentional empty form row and is still dropped.
    if (typeof p !== 'object' || p === null) return { ok: false, error: 'malformed part' };
    const pr = p as Record<string, unknown>;
    const label = typeof pr.label === 'string' ? pr.label.trim() : '';
    if (!label) continue; // drop blank rows (the song form adds empty part rows the director can skip)
    // Bound to the smallint range of part.count_needed: an out-of-range value (e.g. 32768)
    // would survive coercion and fail the child INSERT, stranding a parent ghost song.
    const count =
      typeof pr.countNeeded === 'number' && pr.countNeeded >= 1 ? Math.min(Math.round(pr.countNeeded), 32767) : 1;
    const isSolo = pr.isSolo === true;
    // A solo has no section; a section part needs a known voice part. The schema
    // enforces exactly this (is_solo XOR voice_part), so reject a section part
    // with no section rather than store a row Postgres would refuse.
    const voicePartId =
      isSolo || typeof pr.voicePartId !== 'string' || !sectionIds.has(pr.voicePartId)
        ? null
        : pr.voicePartId;
    if (!isSolo && voicePartId === null) {
      return { ok: false, error: `part "${label}" needs a section (or mark it a solo)` };
    }
    // Keep range low <= high, matching the schema check and coerceMemberInput.
    let low = noteOrNull(pr.rangeLow);
    let high = noteOrNull(pr.rangeHigh);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    parts.push({
      id: typeof pr.id === 'string' && UUID_RE.test(pr.id) ? pr.id : undefined,
      label,
      isRequired: pr.isRequired !== false, // default required
      countNeeded: count,
      voicePartId,
      isSolo,
      rangeLowMidi: low,
      rangeHighMidi: high,
    });
  }

  // Key and tempo pair: an end value is where the song LANDS if it modulates, so it is
  // meaningless without a start. The schema enforces this
  // (`end_key_fifths is null or start_key_fifths is not null`, likewise for tempo); reject the
  // pair here with a clear field message instead of letting the CHECK 500 with an opaque error.
  const startKey = asKey(r.startKey);
  const endKey = asKey(r.endKey);
  if (endKey !== null && startKey === null) {
    return { ok: false, error: 'Set a start key before an end key.' };
  }
  const startTempoBpm = asPosIntCappedOrNull(r.startTempoBpm, MAX_TEMPO_BPM);
  const endTempoBpm = asPosIntCappedOrNull(r.endTempoBpm, MAX_TEMPO_BPM);
  if (endTempoBpm !== null && startTempoBpm === null) {
    return { ok: false, error: 'Set a start tempo before an end tempo.' };
  }

  return {
    ok: true,
    value: {
      song: {
        title,
        startKey,
        endKey,
        startTempoBpm,
        endTempoBpm,
        durationSeconds: asPosIntCappedOrNull(r.durationSeconds, MAX_DURATION_SECONDS),
        isExplicit: r.isExplicit === true,
        usesAccompaniment: r.usesAccompaniment === true, // default false: a cappella
        intensity,
        tags,
        assessedReadiness: readiness,
        bookStatus,
      },
      arranger: asTrimmedOrNull(r.arranger),
      chartRef: asTrimmedOrNull(r.chartRef),
      lastRehearsed: dateOrNull(r.lastRehearsed),
      // The pitch to blow, a pitch class entered as typed (e.g. "C#", "Eb");
      // null = derive from the start key on the sheet. Stored verbatim, no octave.
      startPitch: pitchClassOrNull(r.startPitch),
      parts,
    },
  };
}
