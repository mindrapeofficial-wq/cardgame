-- Custom game accounts remain authoritative; provider emails never select a game account.
alter table public.rolplay_accounts add column password_enabled boolean not null default true;
create table public.rolplay_social_identities (
  auth_user_id uuid primary key,
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index rolplay_social_account_idx on public.rolplay_social_identities(account_id);
create table public.rolplay_auth_erasure_queue (
  auth_user_id uuid primary key,
  created_at timestamptz not null default now()
);
create table public.rolplay_notification_preferences (
  account_id uuid primary key references public.rolplay_accounts(id) on delete cascade,
  challenges boolean not null default false,
  friends boolean not null default false,
  packs boolean not null default false,
  messages boolean not null default false
);
create table public.rolplay_push_devices (
  token text primary key check(char_length(token) between 20 and 4096),
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index rolplay_push_account_idx on public.rolplay_push_devices(account_id,updated_at);
create table public.rolplay_direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  recipient_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  body text not null check(char_length(body) between 1 and 500),
  client_id uuid not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(sender_id,client_id), check(sender_id<>recipient_id)
);
create index rolplay_dm_sender_time_idx on public.rolplay_direct_messages(sender_id,created_at desc,id);
create index rolplay_dm_recipient_time_idx on public.rolplay_direct_messages(recipient_id,created_at desc,id);
create index rolplay_dm_unread_idx on public.rolplay_direct_messages(recipient_id,sender_id) where read_at is null;
create table public.rolplay_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  source_id uuid references public.rolplay_accounts(id) on delete cascade,
  category text not null check(category in ('challenges','friends','packs','messages')),
  event_key text not null check(char_length(event_key)<=200),
  route text not null check(route in ('home','friends','shop','messages')),
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','processing','sent','skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  unique(account_id,event_key)
);
create index rolplay_push_queue_idx on public.rolplay_notification_outbox(status,next_attempt_at,created_at);

do $$ declare t text; begin
  foreach t in array array['rolplay_social_identities','rolplay_auth_erasure_queue','rolplay_notification_preferences',
    'rolplay_push_devices','rolplay_direct_messages','rolplay_notification_outbox'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create function public.rolplay_social_account(p_auth_user uuid,p_existing uuid,p_username text,p_age text,p_terms text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
  -- Serialize concurrent callbacks for this identity, including first registration.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_auth_user::text,0));
  if exists(select 1 from public.rolplay_auth_erasure_queue where auth_user_id=p_auth_user)
    then raise exception 'social_auth_invalid'; end if;
  select account_id into v_id from public.rolplay_social_identities where auth_user_id=p_auth_user;
  if found then
    if p_existing is not null and p_existing<>v_id then raise exception 'identity_already_linked'; end if;
    return v_id;
  end if;
  if p_existing is not null then
    perform 1 from public.rolplay_accounts where id=p_existing and suspended_at is null for update;
    if not found then raise exception 'account_not_found'; end if;
    v_id:=p_existing;
  else
    if not coalesce(p_username ~ '^[A-Za-z0-9_-]{3,20}$' and p_age in ('16-17','18+') and p_terms='2026-10-03',false)
      then raise exception 'social_registration_required'; end if;
    insert into public.rolplay_accounts(username,username_key,password_hash,password_salt,password_enabled,
      age_group,terms_version,terms_accepted_at,gold,collection,deck)
      values(p_username,lower(p_username),encode(extensions.gen_random_bytes(32),'base64'),
        encode(extensions.gen_random_bytes(16),'base64'),false,p_age,p_terms,now(),100,'{}','[]') returning id into v_id;
  end if;
  insert into public.rolplay_social_identities(auth_user_id,account_id) values(p_auth_user,v_id);
  return v_id;
end $$;
revoke execute on function public.rolplay_social_account(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.rolplay_social_account(uuid,uuid,text,text,text) to service_role;

create function public.rolplay_queue_notification(p_account uuid,p_source uuid,p_category text,p_key text,p_route text,p_expires timestamptz)
returns void language sql security invoker set search_path='' as $$
  insert into public.rolplay_notification_outbox(account_id,source_id,category,event_key,route,expires_at)
  select p_account,p_source,p_category,p_key,p_route,p_expires
  from public.rolplay_accounts a join public.rolplay_notification_preferences p on p.account_id=a.id
  where a.id=p_account and a.suspended_at is null and not a.is_bot and a.terms_version='2026-10-03'
    and case p_category when 'challenges' then p.challenges when 'friends' then p.friends
      when 'packs' then p.packs when 'messages' then p.messages else false end
    and (p_source is null or not exists(select 1 from public.rolplay_blocks b where
      (b.account_id=p_account and b.blocked_id=p_source) or (b.account_id=p_source and b.blocked_id=p_account)))
    and exists(select 1 from public.rolplay_push_devices d where d.account_id=p_account and d.updated_at>now()-interval '45 days')
  on conflict do nothing;
$$;
revoke execute on function public.rolplay_queue_notification(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.rolplay_queue_notification(uuid,uuid,text,text,text,timestamptz) to service_role;

create function public.rolplay_friend_push_trigger() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.status='pending' then
    perform public.rolplay_queue_notification(new.friend_id,new.account_id,'friends',
      'friend:'||new.account_id::text||':'||new.created_at::text,'friends',now()+interval '1 day');
  end if;
  return new;
end $$;
revoke execute on function public.rolplay_friend_push_trigger() from public,anon,authenticated;
create trigger rolplay_friend_push after insert on public.rolplay_friends for each row execute function public.rolplay_friend_push_trigger();

create function public.rolplay_send_direct_message(p_sender uuid,p_recipient uuid,p_body text,p_client uuid)
returns public.rolplay_direct_messages language plpgsql security invoker set search_path='' as $$
declare v_message public.rolplay_direct_messages;
begin
  perform 1 from public.rolplay_accounts where id in(p_sender,p_recipient) order by id for update;
  if p_sender=p_recipient or not exists(select 1 from public.rolplay_accounts where id=p_recipient and not is_bot
      and suspended_at is null and terms_version='2026-10-03') or not exists(select 1 from public.rolplay_accounts
      where id=p_sender and not is_bot and suspended_at is null and terms_version='2026-10-03')
    then raise exception 'message_unavailable'; end if;
  if not exists(select 1 from public.rolplay_friends where account_id=p_sender and friend_id=p_recipient and status='accepted')
    or not exists(select 1 from public.rolplay_friends where account_id=p_recipient and friend_id=p_sender and status='accepted')
    then raise exception 'friends_required'; end if;
  if exists(select 1 from public.rolplay_blocks where (account_id=p_sender and blocked_id=p_recipient)
    or(account_id=p_recipient and blocked_id=p_sender)) then raise exception 'player_blocked'; end if;
  select * into v_message from public.rolplay_direct_messages where sender_id=p_sender and client_id=p_client;
  if found then
    if v_message.recipient_id<>p_recipient or v_message.body<>p_body then raise exception 'message_id_conflict'; end if;
    return v_message;
  end if;
  if (select count(*) from public.rolplay_direct_messages where sender_id=p_sender and created_at>now()-interval '1 minute')>=20
    or(select count(*) from public.rolplay_direct_messages where sender_id=p_sender and created_at>now()-interval '1 day')>=500
    then raise exception 'message_limit'; end if;
  insert into public.rolplay_direct_messages(sender_id,recipient_id,body,client_id)
    values(p_sender,p_recipient,p_body,p_client) returning * into v_message;
  perform public.rolplay_queue_notification(p_recipient,p_sender,'messages','dm:'||v_message.id::text,'messages',now()+interval '1 day');
  return v_message;
end $$;
revoke execute on function public.rolplay_send_direct_message(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.rolplay_send_direct_message(uuid,uuid,text,uuid) to service_role;

-- Account locks coordinate sending with blocking and deletion.
create or replace function public.rolplay_block_account(p_account_id uuid,p_blocked_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.rolplay_accounts where id in(p_account_id,p_blocked_id) order by id for update;
  insert into public.rolplay_blocks(account_id,blocked_id) values(p_account_id,p_blocked_id) on conflict do nothing;
  delete from public.rolplay_friends where(account_id=p_account_id and friend_id=p_blocked_id)
    or(account_id=p_blocked_id and friend_id=p_account_id);
end $$;

-- Queue provider erasure in the same transaction as game deletion. The server retries failures.
create function public.rolplay_social_erasure_trigger() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  insert into public.rolplay_auth_erasure_queue(auth_user_id)
    select auth_user_id from public.rolplay_social_identities where account_id=old.id on conflict do nothing;
  return old;
end $$;
revoke execute on function public.rolplay_social_erasure_trigger() from public,anon,authenticated;
create trigger rolplay_social_erasure before delete on public.rolplay_accounts for each row execute function public.rolplay_social_erasure_trigger();

create function public.rolplay_claim_push_jobs() returns setof public.rolplay_notification_outbox
language sql security invoker set search_path='' as $$
  update public.rolplay_notification_outbox o set status='processing',attempts=attempts+1,next_attempt_at=now()+interval '2 minutes'
  where o.id in(select id from public.rolplay_notification_outbox where
    (status='pending' or(status='processing' and next_attempt_at<now())) and next_attempt_at<=now()
    and expires_at>now() and attempts<5 order by created_at for update skip locked limit 10) returning o.*;
$$;
revoke execute on function public.rolplay_claim_push_jobs() from public,anon,authenticated;
grant execute on function public.rolplay_claim_push_jobs() to service_role;

create function public.rolplay_queue_pack_reminders() returns void language sql security invoker set search_path='' as $$
  select public.rolplay_queue_notification(a.id,null,'packs','pack:'||(now() at time zone 'Europe/Madrid')::date::text,
    'shop',(date_trunc('day',now() at time zone 'Europe/Madrid')+interval '1 day') at time zone 'Europe/Madrid')
  from public.rolplay_accounts a join public.rolplay_notification_preferences p on p.account_id=a.id
  where p.packs and not a.is_bot and a.suspended_at is null and a.terms_version='2026-10-03'
    and a.last_daily_pack is distinct from (now() at time zone 'Europe/Madrid')::date
    and (now() at time zone 'Europe/Madrid')::time between time '09:30' and time '20:00'
    and exists(select 1 from public.rolplay_push_devices d where d.account_id=a.id and d.updated_at>now()-interval '45 days')
    and not exists(select 1 from public.rolplay_notification_outbox o where o.account_id=a.id
      and o.event_key='pack:'||(now() at time zone 'Europe/Madrid')::date::text) limit 100;
$$;
revoke execute on function public.rolplay_queue_pack_reminders() from public,anon,authenticated;
grant execute on function public.rolplay_queue_pack_reminders() to service_role;

select cron.schedule('arcanum-messages-push-retention','23 * * * *',$job$
  delete from public.rolplay_direct_messages where created_at<now()-interval '90 days';
  delete from public.rolplay_push_devices where updated_at<now()-interval '45 days';
  delete from public.rolplay_notification_outbox where expires_at<now()-interval '2 days';
$job$);
