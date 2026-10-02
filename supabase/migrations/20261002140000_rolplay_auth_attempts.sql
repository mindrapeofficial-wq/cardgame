-- Throttling for login and registration in rolplay-api.
-- kind: 'login_fail_user' (subject = username key), 'login_fail_ip' / 'register_ip'
-- (subject = SHA-256 of the client IP, so raw IPs are never stored).
create table if not exists public.rolplay_auth_attempts (
  id bigint generated always as identity primary key,
  kind text not null,
  subject text not null,
  created_at timestamptz not null default now()
);
create index if not exists rolplay_auth_attempts_lookup_idx
  on public.rolplay_auth_attempts (kind, subject, created_at desc);
alter table public.rolplay_auth_attempts enable row level security;
revoke all on table public.rolplay_auth_attempts from anon, authenticated;
