-- Persist the director's hand-arranged running order (Bug5 root fix).
--
-- Before this, a draft had no persisted order: the drafter re-sequenced from pins on every load, and
-- a free reorder (drag / arrows / Auto-arrange) lived only in client state. So publish and share froze
-- the CANONICAL re-drafted order — not what the director arranged — and a reload lost the arrangement.
-- Only perform captured it (it sends the on-screen order). See migration 041's "freeze the current
-- draft order": the intent was to freeze what the director sees; this makes that true.
--
-- arranged_order is a jsonb array of song ids: the order the director manually set. loadSetlist
-- applies it (reconciled to the drafted set) so the director's view, publish, and share all honor it.
-- It is advisory, not a snapshot: the drafter still decides membership; this only overrides order.
-- A redraft (pin change / Re-generate) clears it back to null (the canonical order takes over); a
-- drag / Auto-arrange sets it. No constraint — loadSetlist reconciles a stale/partial list defensively.
alter table setlist
add column arranged_order jsonb;
