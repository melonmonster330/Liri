-- 20260408_subscriptions.sql
-- Stripe subscription tiers for Liri
--
-- Free tier:    up to 10 albums in library
-- Premium tier: unlimited albums, all features
--
-- Rows are created by the stripe-webhook handler (server-side only).
-- Users can only read their own row (SELECT via RLS).

-- ── Table ──────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  user_id                uuid        primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text        unique,
  stripe_subscription_id text        unique,
  tier                   text        not null default 'free'
                                     check (tier in ('free', 'premium')),
  status                 text        not null default 'active'
                                     check (status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid')),
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.subscriptions is
  'Stripe subscription state per user. Managed exclusively by the stripe-webhook API (service role). Clients read-only.';

-- ── Index for Stripe customer lookups ──────────────────────────────────────────
create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);

-- ── Row-Level Security ─────────────────────────────────────────────────────────
alter table public.subscriptions enable row level security;

-- Users can read their own subscription row
create policy "users_read_own_subscription"
  on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- Only the service role (webhook handler) can write rows
-- (No INSERT/UPDATE/DELETE policies for authenticated or anon roles)
