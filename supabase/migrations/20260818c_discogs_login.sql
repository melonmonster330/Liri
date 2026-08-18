-- Discogs as a Liri sign-in identity.
--
-- A pending OAuth request may now start while logged out, before a Liri user
-- exists. Once Discogs proves ownership, the callback creates a Liri user or
-- finds the user already linked to that Discogs identity.

ALTER TABLE public.discogs_oauth_pending
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.discogs_oauth_pending
  ADD COLUMN IF NOT EXISTS native_callback boolean NOT NULL DEFAULT false;

-- A Discogs identity can belong to exactly one Liri account. Multiple NULLs
-- remain allowed for any legacy rows whose Discogs id was unavailable.
CREATE UNIQUE INDEX IF NOT EXISTS user_discogs_accounts_discogs_user_id_unique
  ON public.user_discogs_accounts (discogs_user_id)
  WHERE discogs_user_id IS NOT NULL;
