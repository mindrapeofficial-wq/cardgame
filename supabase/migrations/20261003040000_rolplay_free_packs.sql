-- Free packs: one per day (Europe/Madrid calendar day) and a one-off reward for joining the
-- Discord server. The claim check and the pack are applied in one locked transaction so a
-- double click can never grant two packs.
alter table public.rolplay_accounts
  add column if not exists last_daily_pack date,
  add column if not exists discord_reward_claimed_at timestamptz;

create or replace function public.rolplay_claim_free_pack(p_account uuid, p_kind text, p_card_ids integer[])
returns public.rolplay_accounts
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.rolplay_accounts;
  today date := (now() at time zone 'Europe/Madrid')::date;
begin
  select * into a from public.rolplay_accounts where id = p_account for update;
  if not found then raise exception 'account_not_found'; end if;
  if p_kind = 'daily' then
    if a.last_daily_pack = today then raise exception 'daily_already_claimed'; end if;
    update public.rolplay_accounts set last_daily_pack = today where id = p_account;
  elsif p_kind = 'discord' then
    if a.discord_reward_claimed_at is not null then raise exception 'discord_already_claimed'; end if;
    update public.rolplay_accounts set discord_reward_claimed_at = now() where id = p_account;
  else
    raise exception 'free_pack_kind_invalid';
  end if;
  return public.rolplay_buy_pack(p_account, p_card_ids, 0);
end;
$function$;

revoke execute on function public.rolplay_claim_free_pack(uuid, text, integer[]) from public, anon, authenticated;
