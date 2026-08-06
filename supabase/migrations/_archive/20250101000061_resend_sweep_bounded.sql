-- Make the invite_rate_event sweep deterministic and bounded.
--
-- Migration 056 swept expired rows on roughly 1% of calls, and its comment at 056:59-62 describes
-- that as amortized and cheap. That comment is now wrong and 056 is immutable, so the correction
-- lives here. Two things were wrong with it.
--
-- The sweep only ever runs inside a request, so cleanup is coupled to traffic. A burst that stops
-- leaves its rows behind until roughly a hundred more organic calls arrive, which at a realistic
-- resend volume is weeks. And the unlucky real user whose call finally draws the 1% branch pays to
-- delete the entire backlog synchronously, inside a serverless function, while an anonymous caller
-- pays nothing.
--
-- Sweeping a fixed 50 rows on every call inverts that. Drain (50 per call) exceeds creation (at
-- most 1 per call), so the table is bounded by roughly an hour of accepted traffic instead of by
-- how recently someone got unlucky, and no single caller ever pays for the whole backlog. Oldest
-- first, so the rows collected are exactly the expired ones.
--
-- The per-subject prune that used to sit after the advisory lock is gone. It contributed nothing to
-- the ceiling, because the count below is already time-filtered, and combining it with a sweep that
-- row-locks arbitrary rows before taking the advisory lock closes a deadlock cycle. With it removed
-- the only writer contention left is sweep against sweep, which skip locked handles.
--
-- What this does NOT do. It does not bound request volume, function invocations or pooler
-- connections, and no database ceiling can. That is a platform rate-limit rule on
-- /api/auth/resend, keyed by IP. A global hourly ceiling was considered and rejected: it would be
-- consumed before the per-email check, so a few hundred requests would switch off self-serve
-- invite recovery for every real user, which trades a bounded and reclaimable table for an outage
-- of the account-recovery path.

create or replace function consume_kind(p_subject text, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_key    text := nullif(p_subject, '');
v_window interval := interval '1 hour';
v_limit  int;
v_count  int;
begin
if v_key is null then
return false;
end if;
-- Server-authoritative ceilings (per hour). The client never supplies these.
v_limit := case p_kind
when 'director_invite' then 20
when 'member_invite'   then 30
when 'resend'          then 3
else 0
end;
if v_limit <= 0 then
return false;  -- unknown kind: no allowance
end if;
-- Collect a fixed slice of expired rows across ALL subjects, oldest first. The array form is
-- deliberate: it plans as a locked index scan on the created_at index feeding a bitmap probe on the
-- primary key, where the equivalent delete ... using seq-scans the outer side, which is the wrong
-- shape on exactly the backlog this exists to drain. skip locked means concurrent callers take
-- disjoint slices instead of queueing, and the whole thing runs before the advisory lock below so
-- it never holds row locks while waiting on one.
delete from public.invite_rate_event
where id = any (array(
    select e.id from public.invite_rate_event e
    where e.created_at <= now() - interval '1 hour'
    order by e.created_at
    limit 50
    for update skip locked
));
perform pg_advisory_xact_lock(hashtext('invite_rate:' || p_kind), hashtext(v_key));
select count(*) into v_count
from public.invite_rate_event
where subject = v_key and kind = p_kind and created_at > now() - v_window;
if v_count >= v_limit then
return false;
end if;
insert into public.invite_rate_event (subject, kind) values (v_key, p_kind);
return true;
end;
$$;
revoke all on function consume_kind(text, text) from public;
