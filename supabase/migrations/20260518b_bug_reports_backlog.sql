ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retried_at timestamptz;

ALTER TABLE public.bug_reports
  DROP CONSTRAINT IF EXISTS bug_reports_status_check;

ALTER TABLE public.bug_reports
  ADD CONSTRAINT bug_reports_status_check
  CHECK (status IN ('open', 'fixed', 'wontfix', 'backlog'));

CREATE INDEX IF NOT EXISTS idx_bug_reports_backlog_retried
  ON public.bug_reports (status, last_retried_at)
  WHERE status IN ('open', 'backlog');
