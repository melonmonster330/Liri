-- 20260428_add_subscription_source.sql
-- Add source column to subscriptions to distinguish paid vs complimentary premium.
--
-- source values:
--   'stripe' — paid via Stripe (default for existing rows)
--   'apple'  — paid via Apple IAP
--   'admin'  — complimentary / granted by admin (not a paying customer)
--
-- To grant a user complimentary premium, run in Supabase SQL editor:
--   INSERT INTO public.subscriptions (user_id, tier, status, source)
--   VALUES ('<user_uuid>', 'premium', 'active', 'admin')
--   ON CONFLICT (user_id) DO UPDATE SET tier = 'premium', status = 'active', source = 'admin';

alter table public.subscriptions
  add column if not exists source text not null default 'stripe'
    check (source in ('stripe', 'apple', 'admin'));
