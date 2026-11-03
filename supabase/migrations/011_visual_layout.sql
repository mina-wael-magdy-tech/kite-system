-- ====================================================================
-- KITE SYSTEM — 011_visual_layout.sql
--   Where each picture sits on a content-plan slide: { x, y, w, h, fit, z } in % of the picture area.
--   NULL = placed automatically in a grid. Safe to run more than once.
-- ====================================================================

ALTER TABLE public.content_post_assets ADD COLUMN IF NOT EXISTS layout JSONB;

ALTER TABLE public.content_post_assets DROP CONSTRAINT IF EXISTS content_post_assets_layout_check;
ALTER TABLE public.content_post_assets ADD CONSTRAINT content_post_assets_layout_check
  CHECK (layout IS NULL OR (jsonb_typeof(layout) = 'object' AND pg_column_size(layout) < 400));
