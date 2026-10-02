-- Internal marker for pre-launch synthetic population accounts.
-- Never expose this flag in the public profile payload.
alter table public.rolplay_accounts
  add column if not exists is_synthetic boolean not null default false;

create index if not exists rolplay_accounts_is_synthetic_idx
  on public.rolplay_accounts (is_synthetic)
  where is_synthetic = true;

comment on column public.rolplay_accounts.is_synthetic is
  'Internal-only marker for automated pre-launch QA accounts.';
