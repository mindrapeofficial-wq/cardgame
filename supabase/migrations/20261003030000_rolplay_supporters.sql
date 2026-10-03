-- Supporter tiers paid through Stripe Checkout (rolplay-api support_checkout + stripe-webhook).
-- Rewards are recognition only (badge, title, coloured name, wall) plus manual rewards tracked
-- in rolplay_support_payments.rewards (exclusive card, naming a card, being a card).
alter table public.rolplay_accounts
  add column if not exists supporter_tier text check (supporter_tier in ('apoyador', 'fundador', 'mecenas', 'leyenda')),
  add column if not exists supporter_since timestamptz;

create table if not exists public.rolplay_support_payments (
  session_id text primary key,                -- Stripe Checkout Session id (idempotency)
  account_id uuid not null references public.rolplay_accounts(id) on delete cascade,
  tier text not null check (tier in ('apoyador', 'fundador', 'mecenas', 'leyenda')),
  amount_cents integer not null,
  currency text not null default 'eur',
  livemode boolean not null default false,
  rewards jsonb not null default '{}'::jsonb, -- manual rewards: { "card_delivered": true, ... }
  note text,
  created_at timestamptz not null default now()
);
create index if not exists rolplay_support_payments_account_idx on public.rolplay_support_payments (account_id);
alter table public.rolplay_support_payments enable row level security;
revoke all on public.rolplay_support_payments from anon, authenticated;
