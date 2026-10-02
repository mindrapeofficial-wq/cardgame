-- Keys that identify the trusted multiplayer server to rolplay-api.
-- Only SHA-256 hashes are stored; the raw key lives in the Render env var ROLPLAY_SERVER_KEY.
create table if not exists public.rolplay_server_keys (
  key_hash text primary key,
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table public.rolplay_server_keys enable row level security;
revoke all on table public.rolplay_server_keys from anon, authenticated;

-- Training results are reported by the client, so their gold is capped server-side:
-- at most 10 paid wins per 24h, at least 90s apart, and at most 60 records per 24h.
-- The account row lock makes the caps hold under concurrent requests.
create or replace function public.rolplay_award_training(p_account uuid, p_reward_key text, p_win boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.rolplay_accounts;
  recent_count integer;
  paid_count integer;
  last_paid timestamptz;
  reward_gold integer := 0;
  res text := case when p_win then 'training_win' else 'training_loss' end;
begin
  select * into a from public.rolplay_accounts where id = p_account for update;
  if not found then raise exception 'account_not_found'; end if;

  if exists (select 1 from public.rolplay_match_rewards where reward_key = p_reward_key) then
    return jsonb_build_object('account', to_jsonb(a), 'gold', 0, 'limited', false, 'duplicate', true);
  end if;

  select count(*)::integer,
         (count(*) filter (where gold_awarded > 0))::integer,
         max(created_at) filter (where gold_awarded > 0)
    into recent_count, paid_count, last_paid
    from public.rolplay_match_rewards
   where account_id = p_account
     and result in ('training_win', 'training_loss')
     and created_at > now() - interval '24 hours';

  if recent_count >= 60 then
    return jsonb_build_object('account', to_jsonb(a), 'gold', 0, 'limited', true, 'duplicate', false);
  end if;

  if p_win and paid_count < 10 and (last_paid is null or last_paid < now() - interval '90 seconds') then
    reward_gold := 2;
  end if;

  a := public.rolplay_apply_xp_gold_result(p_account, p_reward_key, 0, reward_gold, res);
  return jsonb_build_object('account', to_jsonb(a), 'gold', reward_gold, 'limited', false, 'duplicate', false);
end;
$function$;

revoke all on function public.rolplay_award_training(uuid, text, boolean) from public, anon, authenticated;
