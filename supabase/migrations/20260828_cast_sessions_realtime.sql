-- The universal TV receiver watches room updates through Postgres Changes.
-- Keep this idempotent so environments already configured in the dashboard
-- can apply the migration safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cast_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cast_sessions;
  END IF;
END
$$;
