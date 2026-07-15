-- ============================================================
-- Liri — record-shop artist ordering
--
-- MusicBrainz's human-curated artist sort name ("Bowie, David";
-- "Rolling Stones, The") — fetched once per album at add time by
-- api/add-to-library.js and backfilled for existing rows by
-- scripts/backfill-artist-sort-names.js. NULL when MusicBrainz has
-- no confident match; clients fall back to plain artist_name.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.catalogue
  ADD COLUMN IF NOT EXISTS artist_sort_name text;
