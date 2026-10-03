-- Discord account linking (OAuth2, scopes identify + guilds.members.read). The discord-oauth
-- edge function stores the Discord user and whether they belong to the ARCANUM server; the
-- Discord welcome pack now requires a verified member, and one Discord account can only be
-- linked to one game account.
alter table public.rolplay_accounts
  add column if not exists discord_user_id text unique,
  add column if not exists discord_username text,
  add column if not exists discord_member boolean not null default false,
  add column if not exists discord_linked_at timestamptz;

create table if not exists public.rolplay_discord_states (
  state text primary key,
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.rolplay_discord_states enable row level security;
revoke all on public.rolplay_discord_states from anon, authenticated;

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
    if not a.discord_member then raise exception 'discord_not_member'; end if;
    update public.rolplay_accounts set discord_reward_claimed_at = now() where id = p_account;
  else
    raise exception 'free_pack_kind_invalid';
  end if;
  return public.rolplay_buy_pack(p_account, p_card_ids, 0);
end;
$function$;

revoke execute on function public.rolplay_claim_free_pack(uuid, text, integer[]) from public, anon, authenticated;
