-- Remove the superseded legacy performance path. perform_setlist(uuid, uuid[]) (migration 6,
-- retimed in 11) is the only write that closes the performed loop now: it materializes the
-- frozen order, snapshots soloists, stamps performed_date, and serializes the freeze. The old
-- mark_setlist_performed(uuid) stamped last_performed but wrote no order, no soloists, and no
-- performed_date, so leaving it callable was a way to mark a set "performed" while bypassing the
-- whole snapshot — a real hazard, not just dead code. Its @repertoire/api PerformSource wiring is
-- removed in the same change, so nothing calls it anymore.
revoke all on function public.mark_setlist_performed(uuid) from public, authenticated;
drop function if exists public.mark_setlist_performed(uuid);
