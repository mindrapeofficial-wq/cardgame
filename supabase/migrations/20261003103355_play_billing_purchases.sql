create table public.rolplay_play_purchases (
  purchase_token text primary key,
  account_id uuid references public.rolplay_accounts(id) on delete set null,
  product_id text not null check(product_id in ('arcanum_apoyador','arcanum_fundador','arcanum_mecenas','arcanum_leyenda')),
  order_id text,
  status text not null default 'purchased' check(status in ('purchased','revoked')),
  test_purchase boolean not null default false,
  acknowledged boolean not null default false,
  purchased_at timestamptz not null,
  checked_at timestamptz not null default now()
);
create index rolplay_play_purchases_account_idx on public.rolplay_play_purchases(account_id);
alter table public.rolplay_play_purchases enable row level security;
revoke all on public.rolplay_play_purchases from anon, authenticated;
grant all on public.rolplay_play_purchases to service_role;

create function public.rolplay_apply_play_purchase(p_account_id uuid,p_token text,p_product text,p_order text,p_test boolean,p_purchased_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare v_owner uuid; v_tier text; v_rank integer; v_current integer;
begin
  -- Lock the account so deletion cannot race with granting a purchase.
  perform 1 from public.rolplay_accounts where id=p_account_id and suspended_at is null for update;
  if not found then raise exception 'account_not_found'; end if;
  insert into public.rolplay_play_purchases(purchase_token,account_id,product_id,order_id,test_purchase,purchased_at)
    values(p_token,p_account_id,p_product,p_order,p_test,p_purchased_at) on conflict do nothing;
  select account_id into v_owner from public.rolplay_play_purchases where purchase_token=p_token for update;
  if v_owner is distinct from p_account_id then raise exception 'purchase_account_mismatch'; end if;
  v_tier:=replace(p_product,'arcanum_','');
  v_rank:=case v_tier when 'apoyador' then 1 when 'fundador' then 2 when 'mecenas' then 3 when 'leyenda' then 4 else 0 end;
  select case supporter_tier when 'apoyador' then 1 when 'fundador' then 2 when 'mecenas' then 3 when 'leyenda' then 4 else 0 end
    into v_current from public.rolplay_accounts where id=p_account_id;
  update public.rolplay_play_purchases set checked_at=now(),status='purchased' where purchase_token=p_token;
  if v_rank>v_current then update public.rolplay_accounts set supporter_tier=v_tier,supporter_since=coalesce(supporter_since,now()) where id=p_account_id; end if;
end;
$$;
revoke execute on function public.rolplay_apply_play_purchase(uuid,text,text,text,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.rolplay_apply_play_purchase(uuid,text,text,text,boolean,timestamptz) to service_role;

create function public.rolplay_revoke_play_purchase(p_token text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_account uuid; v_tier text;
begin
  select account_id into v_account from public.rolplay_play_purchases where purchase_token=p_token;
  if v_account is not null then perform 1 from public.rolplay_accounts where id=v_account for update; end if;
  update public.rolplay_play_purchases set status='revoked',checked_at=now() where purchase_token=p_token;
  if v_account is null then return; end if;
  select tier into v_tier from (
    select tier from public.rolplay_support_payments where account_id=v_account
    union all
    select replace(product_id,'arcanum_','') from public.rolplay_play_purchases where account_id=v_account and status='purchased'
  ) all_payments order by case tier when 'leyenda' then 4 when 'mecenas' then 3 when 'fundador' then 2 when 'apoyador' then 1 else 0 end desc limit 1;
  update public.rolplay_accounts set supporter_tier=v_tier where id=v_account;
end;
$$;
revoke execute on function public.rolplay_revoke_play_purchase(text) from public,anon,authenticated;
grant execute on function public.rolplay_revoke_play_purchase(text) to service_role;

