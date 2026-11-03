-- ====================================================================
-- KITE SYSTEM — 013_plan_colours.sql
--   A content plan has three editable colours: the main colour (accent) and the two soft glows of the cover
--   (top-left and bottom-right). Safe to run more than once.
-- ====================================================================

ALTER TABLE public.content_plans
  ADD COLUMN IF NOT EXISTS accent2 TEXT NOT NULL DEFAULT '#fbba48',
  ADD COLUMN IF NOT EXISTS accent3 TEXT NOT NULL DEFAULT '#7bcbe3';

ALTER TABLE public.content_plans DROP CONSTRAINT IF EXISTS content_plans_accent2_check;
ALTER TABLE public.content_plans ADD CONSTRAINT content_plans_accent2_check CHECK (accent2 ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE public.content_plans DROP CONSTRAINT IF EXISTS content_plans_accent3_check;
ALTER TABLE public.content_plans ADD CONSTRAINT content_plans_accent3_check CHECK (accent3 ~ '^#[0-9a-fA-F]{6}$');
