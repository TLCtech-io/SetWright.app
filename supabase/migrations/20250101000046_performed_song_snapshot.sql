-- Codex bug #3: a performed set is billed as an immutable record, but only its ORDER, soloists, and
-- date are frozen. getPerformedSet and the member call sheet (getPublishedSet) re-read LIVE song
-- metadata (title, keys, tempo, pitch, duration) and the live event (name, padding), so editing a
-- song or event after a gig retroactively rewrites the historical sheet and its duration total.
--
-- Add a jsonb snapshot on the setlist, captured at perform time by the app layer (which owns the
-- row->SongRow mapping, so no SQL duplication), holding the performed songs (full SongRow shape, in
-- order) plus the event name and padding. getPerformedSet / getPublishedSet read it for a performed
-- set and fall back to live reads when it is null — so existing performed sets keep working with no
-- backfill, and only sets performed after this change are truly frozen. Mirrors published_order (041).

alter table setlist add column performed_snapshot jsonb;

comment on column setlist.performed_snapshot is
'Frozen song metadata + event name/padding for a performed set, captured at perform time. Null for '
'sets performed before this column (they fall back to live reads). Shape: '
'{ songs: SongRow[], eventName: text, padding: { perSongSeconds, perSetSeconds } }.';
