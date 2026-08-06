-- Close the INSERT hole in the performed-history immutability guards (review finding on #8).
--
-- Migration 15 made a performed setlist's children (setlist_item / setlist_break /
-- performance_soloist) immutable against UPDATE and DELETE, but NOT against INSERT. The RLS
-- write policy lets a director INSERT directly via PostgREST, and a fresh row (a new song, a
-- new break ordinal, a new soloist part) does not touch the parent setlist row -- so the
-- setlist guard never fires and the row lands in the frozen record, corrupting the historical
-- order / breaks / soloist equity after the fact. The same direct-authenticated-write threat
-- #8 was built to stop.
--
-- guard_performed_child already resolves the setlist id from NEW (its non-DELETE branch), so
-- only the trigger timing needs INSERT added. perform_setlist stays compatible because it writes
-- the children while the parent is still 'draft' (it flips to 'performed' last); the seed now
-- does the same (insert children as draft, then perform), so no legitimate path inserts a child
-- into an already-performed setlist.
drop trigger if exists setlist_item_immutable_guard on public.setlist_item;
create trigger setlist_item_immutable_guard
before insert or update or delete on public.setlist_item
for each row execute function guard_performed_child();

drop trigger if exists setlist_break_immutable_guard on public.setlist_break;
create trigger setlist_break_immutable_guard
before insert or update or delete on public.setlist_break
for each row execute function guard_performed_child();

drop trigger if exists performance_soloist_immutable_guard on public.performance_soloist;
create trigger performance_soloist_immutable_guard
before insert or update or delete on public.performance_soloist
for each row execute function guard_performed_child();
