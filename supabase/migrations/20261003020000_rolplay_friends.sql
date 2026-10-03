-- Friends. A request is one row (requester -> target, 'pending'); accepting turns it into two
-- 'accepted' rows, one per direction, so "my friends" is a single indexed lookup. Only the
-- rolplay-api edge function (service role) touches this table.
create table if not exists public.rolplay_friends (
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  friend_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (account_id, friend_id),
  check (account_id <> friend_id)
);
create index if not exists rolplay_friends_friend_idx on public.rolplay_friends (friend_id, status);
alter table public.rolplay_friends enable row level security;
revoke all on public.rolplay_friends from anon, authenticated;
