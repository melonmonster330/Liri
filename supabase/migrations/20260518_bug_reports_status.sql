-- Liri — bug_reports status tracking
--
-- Adds status / fixed_at to bug_reports so we can mark auto-filed bugs
-- (e.g. missing_lyrics) as fixed after a sweep, and easily query what's
-- still open without scanning the meta jsonb.

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS status     text        NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS fixed_at   timestamptz;

-- Constrain status to known values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_status_check'
  ) THEN
    ALTER TABLE public.bug_reports
      ADD CONSTRAINT bug_reports_status_check
      CHECK (status IN ('open', 'fixed', 'wontfix'));
  END IF;
END$$;

-- Index for the common "show me open bugs by category" query
CREATE INDEX IF NOT EXISTS idx_bug_reports_status_category
  ON public.bug_reports (status, ((meta->>'category')));
