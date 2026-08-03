-- Binding an account to a seat is the invitee's act, not the director's.
--
-- member_write (002:161) is a `for all` policy whose only predicate is director-of-this-ensemble,
-- and the blanket grant at 002:107 gives authenticated INSERT as well as UPDATE. Together they let
-- a director write member.user_id straight through the Data API: take any app_user.id they can see
-- and insert or update it onto a seat in an ensemble they direct. That account is then an active
-- member of a tenant it never joined, and ensemble_seat_for_email (052:44) will confirm which
-- address it holds one guess at a time.
--
-- The same outcome is reachable without touching user_id at all. A director of two ensembles can
-- UPDATE a claimed seat's ensemble_id and move the victim between tenants, which also destroys the
-- legitimate seat. guard_last_director does not stop it unless the seat being moved is the old
-- ensemble's sole active director, so both columns are guarded here.
--
-- Nothing in the app writes either column on an existing seat. save_member (027:59) writes five
-- columns on update and seven on insert, never user_id; set_member_status (052:15) writes status;
-- coerceMemberInput has no such field. claim_membership (047:45) is the only writer of user_id, it
-- is SECURITY DEFINER owned by postgres, and it binds on the invitee's own GoTrue-confirmed email.
-- So this is a database guard with no application change behind it.
--
-- A trigger rather than column privileges. Pinning authenticated's UPDATE to a column list, the
-- app_user pattern at 055:19, closes the same paths but the list has to be re-derived every time a
-- member column is added, and getting it wrong breaks director roster editing at runtime with a
-- privilege error no offline gate would ever run. This names two columns and is indifferent to the
-- rest of the table. An RLS WITH CHECK cannot express it at all, because WITH CHECK has no OLD row.

create or replace function guard_member_binding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
-- Only the Data API roles are guarded. claim_membership, create_ensemble and create_ensemble_seeded
-- are SECURITY DEFINER owned by postgres, so current_user is postgres inside them and the binds they
-- perform pass. Seed, migration and service-role writes sit outside these roles too.
if current_user not in ('authenticated', 'anon') then
    return new;
end if;

-- The auth.uid() escape keeps this from resting on the SECURITY DEFINER current_user behaviour
-- alone: a caller may only ever write their OWN account onto a seat. A director self-binding to a
-- second seat in their own ensemble is the only thing it permits, and member_ensemble_id_user_id_key
-- already refuses that.
if tg_op = 'INSERT' then
    if new.user_id is not null and new.user_id is distinct from auth.uid() then
        raise exception 'a member seat cannot be created already bound to an account'
            using errcode = 'insufficient_privilege';
    end if;
    return new;
end if;

if new.user_id is distinct from old.user_id
and new.user_id is distinct from auth.uid() then
    raise exception 'the account on a member seat is set by the invitee, not by a director'
        using errcode = 'insufficient_privilege';
end if;

if new.ensemble_id is distinct from old.ensemble_id then
    raise exception 'a member seat cannot be moved to another ensemble'
        using errcode = 'insufficient_privilege';
end if;

return new;
end;
$$;

-- `update of user_id, ensemble_id` fires only when one of those columns is in the SET list, so an
-- ordinary roster edit pays nothing.
--
-- The name matters. BEFORE triggers fire in alphabetical order, and member_seat_binding_guard sorts
-- after member_last_director_guard (028:96), which therefore still fires first and still reports the
-- more specific rule when the seat being unbound is the ensemble's sole director. A rename to
-- something sorting earlier would silently change which guard answers.
create trigger member_seat_binding_guard
before insert or update of user_id, ensemble_id on public.member
for each row execute function guard_member_binding();
