-- ============================================================
-- 20260513b_lifetime_tier.sql
-- Add 'lifetime' to subscriptions.tier so one-time purchases can be
-- distinguished from recurring premium subs.
--
-- Lifetime rows look like:
--   tier = 'lifetime', status = 'active', stripe_subscription_id IS NULL,
--   current_period_end IS NULL, source IN ('stripe', 'apple')
--
-- Run in the Supabase SQL editor as the postgres / service role.
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the existing tier CHECK constraint and re-add with 'lifetime' included.
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_tier_check;

ALTER TABLE public.subscriptions
  ADD  CONSTRAINT subscriptions_tier_check
       CHECK (tier IN ('free', 'premium', 'lifetime'));

-- Optional: timestamp for when the lifetime purchase happened.
-- Useful for support / refund decisions. Nullable; only set on lifetime rows.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS lifetime_purchased_at timestamptz;

COMMENT ON COLUMN public.subscriptions.tier IS
  '''free'' | ''premium'' (recurring) | ''lifetime'' (one-time, never expires)';

COMMENT ON COLUMN public.subscriptions.lifetime_purchased_at IS
  'When the one-time lifetime payment was confirmed. NULL for non-lifetime rows.';
