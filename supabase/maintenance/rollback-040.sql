-- ====================================================================
-- Rollback for migration 040 (user_tool_access)
-- ====================================================================

DROP TABLE IF EXISTS public.user_tool_access CASCADE;
