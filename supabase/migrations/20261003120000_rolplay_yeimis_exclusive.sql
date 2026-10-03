-- Yeimis: first legendary card (level 1, cost 0, 0/1). Exclusive reward for linking Discord:
-- never in packs, cannot be traded, sold or listed on the market, one copy per account.
alter table public.rolplay_cards
  add column if not exists exclusive boolean not null default false;

insert into public.rolplay_cards (id, name, level, rarity, is_power, is_ability, rarity_tier, level_one_drop_pct, gameplay_score, exclusive)
values (286, 'Yeimis', 1, 100, false, false, 'legendary', null, 1, true)
on conflict (id) do update set name = excluded.name, level = excluded.level, rarity = excluded.rarity,
  rarity_tier = excluded.rarity_tier, level_one_drop_pct = null, exclusive = true;

-- Player-to-player trades refuse exclusive cards (both loops of the settlement).
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rolplay_settle_trade'::regproc);
  if position('card_not_tradeable' in d) = 0 then
    d := replace(d,
      $x$if c.is_power and c.level=1 then raise exception 'basic_power_not_tradeable'; end if;$x$,
      $x$if c.is_power and c.level=1 then raise exception 'basic_power_not_tradeable'; end if;
    if c.exclusive then raise exception 'card_not_tradeable'; end if;$x$);
    if position('card_not_tradeable' in d) = 0 then raise exception 'settle_trade patch did not apply'; end if;
    execute d;
  end if;
end
$mig$;

-- Market listings can neither offer nor ask for an exclusive card.
create or replace function public.rolplay_market_exclusive_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.rolplay_cards where exclusive and id in (new.card_id, new.wanted_card_id)) then
    raise exception 'card_not_tradeable';
  end if;
  return new;
end;
$$;
revoke execute on function public.rolplay_market_exclusive_guard() from public, anon, authenticated;
drop trigger if exists rolplay_market_exclusive_guard on public.rolplay_market_listings;
create trigger rolplay_market_exclusive_guard before insert on public.rolplay_market_listings
  for each row execute function public.rolplay_market_exclusive_guard();

-- Gives one copy of a card if the account has none (idempotent).
create or replace function public.rolplay_grant_exclusive(p_account uuid, p_card integer)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare have integer;
begin
  select coalesce((collection->>p_card::text)::integer, 0) into have from public.rolplay_accounts where id = p_account for update;
  if not found or have > 0 then return false; end if;
  update public.rolplay_accounts
     set collection = jsonb_set(coalesce(collection, '{}'::jsonb), array[p_card::text], to_jsonb(1), true), updated_at = now()
   where id = p_account;
  return true;
end;
$$;
revoke execute on function public.rolplay_grant_exclusive(uuid, integer) from public, anon, authenticated;
grant execute on function public.rolplay_grant_exclusive(uuid, integer) to service_role;

-- Players who already linked Discord and are server members get it now.
select public.rolplay_grant_exclusive(id, 286) from public.rolplay_accounts where discord_user_id is not null and discord_member;
