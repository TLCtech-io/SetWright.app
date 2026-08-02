-- Per-seat invite token: make claiming a seat require possession of a secret delivered to the
-- invited inbox, not merely a matching confirmed email (B1).
--
-- The prior claim_membership() bound any pending seat whose invite_email matched the caller's
-- CONFIRMED auth email. That is only safe when email confirmation proves inbox control — but
-- public signup auto-confirms (locally, and on any misconfigured hosted instance), so an attacker
-- could pre-register a victim's email, auto-confirm it without inbox access, and bind a seat
-- invited under it. The fix removes the email-match trust entirely: each invite carries a random
-- token whose SHA-256 hash is stored on the seat, and the claim binds only when the caller presents
-- the raw token. The token lives only in the email; a member reading the roster sees the hash,
-- which is useless without the preimage.

alter table public.member add column invite_token_hash text;

-- Replace the no-arg claim with a token-gated one.
drop function if exists public.claim_membership();

create or replace function public.claim_membership(p_token text)
returns table (ensemble_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
v_uid  uuid := auth.uid();
v_hash text;
begin
if v_uid is null then
raise exception 'claim_membership: not authenticated';
end if;
if p_token is null or length(p_token) < 16 then
return;  -- no/too-short token: nothing to claim
end if;

-- Hash the presented token the same way the inviter stored it (sha256 hex of the raw string).
v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

return query
with bound as (
    update public.member m
    set user_id          = v_uid,
    invite_email      = null,
    invite_token_hash = null,
    invited_at        = null,
    updated_by        = v_uid,
    updated_at        = now()
    where m.user_id is null
    and m.invite_token_hash is not null
    and m.invite_token_hash = v_hash
    and m.invited_at > now() - interval '14 days'         -- expired invites don't bind
    and not exists (                                       -- preserve unique(ensemble_id,user_id)
        select 1 from public.member m2
        where m2.ensemble_id = m.ensemble_id and m2.user_id = v_uid
    )
    returning m.ensemble_id
)
select bound.ensemble_id from bound;
end;
$$;

revoke all on function public.claim_membership(text) from public;
grant  execute on function public.claim_membership(text) to authenticated;
