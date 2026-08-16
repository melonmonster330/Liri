-- ============================================================
-- 20260816_drop_subscriptions.sql
-- Remove the payment system. Liri is free for everyone with an
-- unlimited library, so nothing reads subscription state anymore.
--
-- This supersedes:
--   20260408_subscriptions.sql        (subscriptions table + RLS)
--   20260428_add_subscription_source.sql (subscriptions.source)
--   20260513b_lifetime_tier.sql       (lifetime tier + lifetime_purchased_at)
--
-- Run in the Supabase SQL editor as the postgres / service role.
-- Idempotent — safe to re-run.
--
-- DESTRUCTIVE: drops the subscriptions table and every row in it.
-- Take a snapshot first if you want the historical rows.
-- ============================================================

-- ── Subscription state ────────────────────────────────────────
-- The RLS policy goes with the table; dropping the table drops it.
DROP TABLE IF EXISTS public.subscriptions CASCADE;

-- ── Free-limit bookkeeping ────────────────────────────────────
-- user_library_ever existed only so removing an album couldn't be used
-- to reset the 10-record free limit. With no limit it has no readers.
DROP TABLE IF EXISTS public.user_library_ever CASCADE;
