-- Enforce performed-history immutability in the database, not just the app (remediation #8).
--
-- Today the only protection is application-layer (the perform RPC's status check + the
-- deleteEvent/deleteSetlist repository methods). A direct authenticated write bypasses all of
-- it: a live probe deleted a performed set and its four soloist snapshots straight through the
-- RLS-scoped API, because the generic director-write policy has no performed-status guard and
-- the FKs cascade. These BEFORE triggers make a performed setlist (and its frozen children) and
-- an event with performed history immutable at the table boundary.
--
-- Compatibility with perform_setlist: it writes the children (setlist_item / performance_soloist)
-- and only then flips the parent to 'performed', so at write time the parent is still 'draft' and
-- the child guard allows it. The status flip itself has old.status <> 'performed', so it passes the
-- setlist guard. Cascading deletes from a NON-performed setlist also pass: when the parent row is
-- already gone the child lookup finds no row (status is null), so the cascade is allowed; a
-- performed parent can never be deleted in the first place (blocked here), so its children are
-- never reached by cascade.

-- An event with performed history cannot be deleted (its performed sets are the record).
create or replace function guard_event_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if exists (select 1 from public.setlist s where s.event_id = old.id and s.status = 'performed') then
raise exception 'cannot delete an event with performed history';
end if;
return old;
end;
$$;

create trigger event_history_delete_guard
before delete on public.event
for each row execute function guard_event_history();

-- A performed setlist is immutable: no update, no delete.
create or replace function guard_performed_setlist()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
if old.status = 'performed' then
raise exception 'performed setlists are immutable';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger setlist_immutable_guard
before update or delete on public.setlist
for each row execute function guard_performed_setlist();

-- A performed setlist's frozen children (order, breaks, soloists) are immutable. The guard
-- allows the row when its parent is gone (a legitimate cascade from a non-performed setlist
-- delete) and blocks it only when the parent is still present and performed.
create or replace function guard_performed_child()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_status text;
begin
select s.status into v_status
from public.setlist s
where s.id = case when tg_op = 'DELETE' then old.setlist_id else new.setlist_id end;
if v_status = 'performed' then
raise exception 'performed setlist history is immutable';
end if;
return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger setlist_item_immutable_guard
before update or delete on public.setlist_item
for each row execute function guard_performed_child();

create trigger setlist_break_immutable_guard
before update or delete on public.setlist_break
for each row execute function guard_performed_child();

create trigger performance_soloist_immutable_guard
before update or delete on public.performance_soloist
for each row execute function guard_performed_child();
