-- ============================================================
-- Liri — "update" post kind (app announcements in the feed)
--
-- Adds an 'update' value to the post_kind enum so the official Liri
-- account can post plain-text app-update announcements ("v1.13 is out:
-- faster loading, lyric posts, …") into everyone's feed.
--
-- The existing per-kind CHECK constraints on posts only constrain their
-- OWN kind (album→collection_id, track→track_id, lyric→track_id+text),
-- so an 'update' post needs no anchor fields — just a caption.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
-- Run this statement on its own in the Supabase SQL editor.
-- Safe to re-run (IF NOT EXISTS).
-- ============================================================

ALTER TYPE post_kind ADD VALUE IF NOT EXISTS 'update';
