alter table public.rolplay_accounts
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists age_group text check (age_group in ('16-17', '18+')),
  add column if not exists suspended_at timestamptz;

create table public.rolplay_blocks (
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  blocked_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, blocked_id),
  check (account_id <> blocked_id)
);
create index rolplay_blocks_target_idx on public.rolplay_blocks(blocked_id);
alter table public.rolplay_blocks enable row level security;
revoke all on public.rolplay_blocks from anon, authenticated;
grant all on public.rolplay_blocks to service_role;

create table public.rolplay_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.rolplay_accounts(id) on delete set null,
  target_id uuid references public.rolplay_accounts(id) on delete set null,
  reason text not null check (reason in ('acoso','odio','contenido_sexual','riesgo_menores','spam','trampas','otro')),
  details text not null default '' check (char_length(details) <= 1000),
  message_id text check (char_length(message_id) <= 100),
  message_text text check (char_length(message_text) <= 300),
  status text not null default 'pending' check (status in ('pending','reviewed','action_taken','dismissed')),
  moderator_note text check (char_length(moderator_note) <= 1000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index rolplay_reports_reporter_created_idx on public.rolplay_reports(reporter_id, created_at);
create index rolplay_reports_pending_idx on public.rolplay_reports(status, created_at);
create index rolplay_reports_target_idx on public.rolplay_reports(target_id);
alter table public.rolplay_reports enable row level security;
revoke all on public.rolplay_reports from anon, authenticated;
grant all on public.rolplay_reports to service_role;

create table public.rolplay_moderators (
  account_id uuid primary key references public.rolplay_accounts(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.rolplay_moderators enable row level security;
revoke all on public.rolplay_moderators from anon, authenticated;
grant all on public.rolplay_moderators to service_role;
-- The owner explicitly selected their existing game username. No generated ID is hardcoded.
insert into public.rolplay_moderators(account_id)
  select id from public.rolplay_accounts where username_key='galante' and not is_bot
  on conflict do nothing;

-- Keep accounting identifiers and amounts, with no link to a deleted player profile.
alter table public.rolplay_support_payments alter column account_id drop not null;
alter table public.rolplay_support_payments drop constraint rolplay_support_payments_account_id_fkey;
alter table public.rolplay_support_payments add constraint rolplay_support_payments_account_id_fkey
  foreign key(account_id) references public.rolplay_accounts(id) on delete set null;

create function public.rolplay_block_account(p_account_id uuid, p_blocked_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.rolplay_blocks(account_id,blocked_id) values(p_account_id,p_blocked_id)
    on conflict do nothing;
  delete from public.rolplay_friends where
    (account_id=p_account_id and friend_id=p_blocked_id) or
    (account_id=p_blocked_id and friend_id=p_account_id);
end;
$$;
revoke execute on function public.rolplay_block_account(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rolplay_block_account(uuid,uuid) to service_role;

create function public.rolplay_suspend_account(p_account_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.rolplay_accounts set suspended_at=now() where id=p_account_id;
  delete from public.rolplay_sessions where account_id=p_account_id;
end;
$$;
revoke execute on function public.rolplay_suspend_account(uuid) from public, anon, authenticated;
grant execute on function public.rolplay_suspend_account(uuid) to service_role;

create function public.rolplay_delete_account(p_account_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_username text;
begin
  select username_key into v_username from public.rolplay_accounts where id=p_account_id for update;
  if not found then raise exception 'account_not_found'; end if;
  update public.rolplay_support_payments set account_id=null, rewards='{}'::jsonb, note=null
    where account_id=p_account_id;
  update public.rolplay_reports set details='', message_text=null, message_id=null, moderator_note=null
    where reporter_id=p_account_id or target_id=p_account_id;
  delete from public.rolplay_auth_attempts where
    (kind='login_fail_user' and subject=v_username) or (kind='delete_fail' and subject=p_account_id::text);
  -- Sessions, decks, friends, blocks, Discord states, seller listings and settlements have
  -- existing cascade FKs. Buyer links and report references have SET NULL FKs.
  delete from public.rolplay_accounts where id=p_account_id;
end;
$$;
revoke execute on function public.rolplay_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.rolplay_delete_account(uuid) to service_role;

-- Hourly cleanup makes the published retention periods operational, even on quiet days.
select cron.schedule('arcanum-privacy-retention','17 * * * *', $job$
  delete from public.rolplay_reports where created_at < now() - interval '90 days';
  delete from public.rolplay_auth_attempts where created_at < now() - interval '48 hours';
  delete from public.rolplay_sessions where expires_at < now();
  delete from public.rolplay_discord_states where created_at < now() - interval '1 hour';
$job$);

