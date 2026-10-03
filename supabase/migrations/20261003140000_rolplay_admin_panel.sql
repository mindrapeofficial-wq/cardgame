-- Admin panel. Administrators are listed in rolplay_admins (only reachable with the service role);
-- every change goes through rolplay_admin_action, which checks the admin, locks the player row,
-- applies the change atomically and writes rolplay_admin_log.
create table if not exists public.rolplay_admins (
  account_id uuid primary key references public.rolplay_accounts(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.rolplay_admins enable row level security;
revoke all on public.rolplay_admins from anon, authenticated;

create table if not exists public.rolplay_admin_log (
  id bigserial primary key,
  admin_id uuid references public.rolplay_accounts(id) on delete set null,
  target_id uuid references public.rolplay_accounts(id) on delete set null,
  target_name text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rolplay_admin_log_target_idx on public.rolplay_admin_log(target_id, created_at desc);
alter table public.rolplay_admin_log enable row level security;
revoke all on public.rolplay_admin_log from anon, authenticated;

alter table public.rolplay_accounts
  add column if not exists suspended_until timestamptz,
  add column if not exists suspension_reason text;

insert into public.rolplay_admins(account_id)
select id from public.rolplay_accounts where username_key = 'galante' and not is_bot
on conflict do nothing;

create or replace function public.rolplay_admin_action(p_admin uuid, p_target uuid, p_action text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.rolplay_accounts;
  n integer;
  card_id integer;
  have integer;
  new_deck jsonb;
  x text;
  kept integer;
  tier text;
  days integer;
begin
  if not exists (select 1 from public.rolplay_admins where account_id = p_admin) then raise exception 'forbidden'; end if;
  select * into a from public.rolplay_accounts where id = p_target for update;
  if not found then raise exception 'player_not_found'; end if;

  if p_action = 'gold' then
    n := (p_data->>'delta')::integer;
    if n is null or abs(n) > 1000000 then raise exception 'amount_invalid'; end if;
    update public.rolplay_accounts set gold = greatest(0, gold + n), updated_at = now() where id = p_target;
  elsif p_action = 'elo' then
    n := (p_data->>'delta')::integer;
    if n is null or abs(n) > 5000 then raise exception 'amount_invalid'; end if;
    update public.rolplay_accounts set elo = greatest(0, elo + n), updated_at = now() where id = p_target;
  elsif p_action = 'level' then
    n := (p_data->>'level')::integer;
    if n is null or n < 1 or n > 50 then raise exception 'level_invalid'; end if;
    update public.rolplay_accounts set level = n, xp = 0, updated_at = now() where id = p_target;
  elsif p_action = 'card' then
    card_id := (p_data->>'cardId')::integer;
    n := (p_data->>'qty')::integer;
    if card_id is null or n is null or n = 0 or abs(n) > 50 then raise exception 'amount_invalid'; end if;
    if not exists (select 1 from public.rolplay_cards where id = card_id) then raise exception 'card_not_found'; end if;
    have := greatest(0, coalesce((a.collection->>card_id::text)::integer, 0) + n);
    -- Removing copies also takes them out of the active deck so it never references cards the
    -- player no longer owns (basic level-1 Power is unlimited and never counted).
    new_deck := '[]'::jsonb; kept := 0;
    for x in select jsonb_array_elements_text(coalesce(a.deck, '[]'::jsonb)) loop
      if x::integer = card_id and not exists (select 1 from public.rolplay_cards where id = card_id and is_power and level = 1) then
        kept := kept + 1;
        if kept > have then continue; end if;
      end if;
      new_deck := new_deck || to_jsonb(x::integer);
    end loop;
    update public.rolplay_accounts
       set collection = case when have = 0 then coalesce(collection, '{}'::jsonb) - card_id::text
                             else jsonb_set(coalesce(collection, '{}'::jsonb), array[card_id::text], to_jsonb(have), true) end,
           deck = new_deck, updated_at = now()
     where id = p_target;
  elsif p_action = 'supporter' then
    tier := nullif(p_data->>'tier', '');
    if tier is not null and tier not in ('apoyador', 'fundador', 'mecenas', 'leyenda') then raise exception 'tier_invalid'; end if;
    update public.rolplay_accounts
       set supporter_tier = tier,
           supporter_since = case when tier is null then null else coalesce(supporter_since, now()) end,
           updated_at = now()
     where id = p_target;
  elsif p_action = 'suspend' then
    if p_target = p_admin then raise exception 'cannot_target_self'; end if;
    days := coalesce((p_data->>'days')::integer, 0);
    if days < 0 or days > 3650 then raise exception 'days_invalid'; end if;
    update public.rolplay_accounts
       set suspended_at = now(),
           suspended_until = case when days = 0 then null else now() + make_interval(days => days) end,
           suspension_reason = left(coalesce(p_data->>'reason', ''), 300),
           updated_at = now()
     where id = p_target;
    delete from public.rolplay_sessions where account_id = p_target;
  elsif p_action = 'unsuspend' then
    update public.rolplay_accounts set suspended_at = null, suspended_until = null, suspension_reason = null, updated_at = now() where id = p_target;
  elsif p_action = 'kick' then
    if p_target = p_admin then raise exception 'cannot_target_self'; end if;
    delete from public.rolplay_sessions where account_id = p_target;
  elsif p_action = 'daily_pack' then
    update public.rolplay_accounts set last_daily_pack = null, updated_at = now() where id = p_target;
  else
    raise exception 'action_invalid';
  end if;

  insert into public.rolplay_admin_log(admin_id, target_id, target_name, action, details)
  values (p_admin, p_target, a.username, p_action, coalesce(p_data, '{}'::jsonb));
  select * into a from public.rolplay_accounts where id = p_target;
  return to_jsonb(a) - 'password_hash' - 'password_salt';
end;
$function$;
revoke execute on function public.rolplay_admin_action(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.rolplay_admin_action(uuid, uuid, text, jsonb) to service_role;

-- Timed suspensions end on their own.
select cron.schedule('arcanum-lift-suspensions', '*/10 * * * *', $job$
  update public.rolplay_accounts set suspended_at = null, suspended_until = null, suspension_reason = null
   where suspended_until is not null and suspended_until <= now();
$job$);
