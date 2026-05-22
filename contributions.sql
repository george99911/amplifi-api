-- Run in Supabase SQL editor (service role bypasses RLS; table still needs to exist).
create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  occasion_id uuid not null references public.occasions (id) on delete cascade,
  guest_name text,
  child_name text,
  amount numeric not null,
  message text,
  status text not null default 'received',
  stripe_payment_intent_id text unique,
  created_at timestamptz default now()
);

create index if not exists contributions_occasion_id_idx on public.contributions (occasion_id);
