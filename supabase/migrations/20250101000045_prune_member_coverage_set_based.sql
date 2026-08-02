-- Codex readability R1: prune_member_coverage looped over every part the departing member led,
-- running an existence check + a candidate pick + an update per part. Replace the per-part loop with
-- one set-based update. Behavior-preserving: the DISTINCT ON reproduces the old LIMIT 1 pick (same
-- confidence rank, then earliest cast), with member id... c.id added as a final tiebreak so a tie on
-- (confidence, created_at) resolves deterministically instead of arbitrarily. Drives member-departure
-- coverage promotion, so semantics matter: verify under the live stack (verify:full) before relying.

create or replace function public.prune_member_coverage(p_ensemble uuid, p_member uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
v_led uuid[];
begin
-- The parts this member led as primary; each may need a new primary once their rows are gone.
select array_agg(part_id) into v_led
from public.casting
where ensemble_id = p_ensemble and member_id = p_member and is_primary;

delete from public.casting     where ensemble_id = p_ensemble and member_id = p_member;
delete from public.availability where ensemble_id = p_ensemble and member_id = p_member;

if v_led is null then return; end if;

-- Promote one new primary per orphaned led part (no primary left after the delete), picking the
-- strongest confidence, then the earliest cast, then the lowest id. One statement replaces the loop.
with next_leads as (
    select distinct on (c.part_id) c.id
    from public.casting c
    where c.ensemble_id = p_ensemble
    and c.part_id = any(v_led)
    and not exists (
        select 1 from public.casting lead
        where lead.ensemble_id = p_ensemble
        and lead.part_id = c.part_id
        and lead.is_primary
    )
    order by
    c.part_id,
    case coalesce(c.self_reported_confidence, 'solid')
    when 'solid' then 0 when 'shaky' then 1 when 'learning' then 2 else 0 end,
    c.created_at,
    c.id
)
update public.casting c
set is_primary = true
from next_leads n
where c.id = n.id;
end;
$$;
revoke all on function public.prune_member_coverage(uuid, uuid) from public;
-- save_member / set_member_status are SECURITY INVOKER and call this as the authenticated caller,
-- so the caller needs EXECUTE; RLS on casting/availability still scopes every row it touches.
grant execute on function public.prune_member_coverage(uuid, uuid) to authenticated;
