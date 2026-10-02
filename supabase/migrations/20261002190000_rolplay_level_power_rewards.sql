-- Original Rolplay level-up rewards (manual 3.2, "Tabla de niveles", column Plus/Poder):
-- reaching these levels grants 2 copies of the listed Power card.
create table if not exists public.rolplay_level_rewards (
  level integer primary key,
  card_name text not null,
  copies integer not null default 2
);
alter table public.rolplay_level_rewards enable row level security;
revoke all on table public.rolplay_level_rewards from anon, authenticated;

insert into public.rolplay_level_rewards(level, card_name, copies) values
  (5, 'Poder x 3', 2), (7, 'Poder x 4', 2), (10, 'Poder x 5', 2), (13, 'Poder x 6', 2),
  (15, 'Poder x 7', 2), (20, 'Poder x 10', 2), (25, 'Poder x 15', 2), (50, 'Poder x 20', 2)
on conflict (level) do update set card_name = excluded.card_name, copies = excluded.copies;

-- Same as before, plus: every reward level crossed by this XP gain adds its cards to the collection.
-- Levels never go down, so each reward is granted exactly once.
create or replace function public.rolplay_apply_xp_gold_result(p_account uuid, p_reward_key text, p_xp integer, p_gold integer, p_result text)
returns rolplay_accounts
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  a public.rolplay_accounts;
  inserted_count integer;
  next_need integer;
  new_xp integer;
  new_level integer;
  col jsonb;
  reward record;
begin
  if p_result not in ('win','draw','loss','training_win','training_loss') then
    raise exception 'invalid_result';
  end if;

  insert into public.rolplay_match_rewards(reward_key,account_id,xp_awarded,gold_awarded,result)
  values(p_reward_key,p_account,p_xp,greatest(0,p_gold),p_result)
  on conflict (reward_key) do nothing;
  get diagnostics inserted_count = row_count;

  select * into a from public.rolplay_accounts where id=p_account for update;
  if not found then raise exception 'account_not_found'; end if;
  if inserted_count=0 then return a; end if;

  new_level := a.level;

  if p_xp >= 0 then
    new_xp := a.xp + p_xp;
    while new_level < 50 loop
      next_need := 100 + 35*(new_level-1) + 5*(new_level-1)*(new_level-1);
      exit when new_xp < next_need;
      new_xp := new_xp - next_need;
      new_level := new_level + 1;
    end loop;
    if new_level >= 50 then
      new_level := 50;
      new_xp := least(new_xp, 999999);
    end if;
  else
    -- Competitive losses can lower the current XP bar, but never de-level.
    new_xp := greatest(0, a.xp + p_xp);
  end if;

  col := coalesce(a.collection, '{}'::jsonb);
  for reward in
    select c.id, r.copies
      from public.rolplay_level_rewards r
      join public.rolplay_cards c on c.name = r.card_name
     where r.level > a.level and r.level <= new_level
  loop
    col := jsonb_set(col, array[reward.id::text],
      to_jsonb(coalesce((col->>reward.id::text)::integer, 0) + reward.copies), true);
  end loop;

  update public.rolplay_accounts
     set level = new_level,
         xp = new_xp,
         total_xp = total_xp + greatest(0,p_xp),
         gold = gold + greatest(0,p_gold),
         collection = col,
         wins = wins + case when p_result='win' then 1 else 0 end,
         draws = draws + case when p_result='draw' then 1 else 0 end,
         losses = losses + case when p_result='loss' then 1 else 0 end,
         updated_at = now()
   where id=p_account
   returning * into a;

  return a;
end;
$function$;

revoke all on function public.rolplay_apply_xp_gold_result(uuid, text, integer, integer, text) from public, anon, authenticated;
