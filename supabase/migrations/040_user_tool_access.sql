-- ====================================================================
-- KITE SYSTEM — 040_user_tool_access.sql
-- Granular per-user tool access management (e.g. Google Flow AI Studio).
-- Managed exclusively by studio administrators (Super Admin, Owner, GM).
-- Visible to assigned users; non-assigned users cannot view or mutate grants.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.user_tool_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tool_key TEXT NOT NULL CHECK (trim(tool_key) <> ''),
    granted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_tool_access UNIQUE (user_id, tool_key)
);

CREATE INDEX IF NOT EXISTS idx_user_tool_access_user ON public.user_tool_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tool_access_tool ON public.user_tool_access(tool_key);

ALTER TABLE public.user_tool_access ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_tool_access TO authenticated;
GRANT ALL ON public.user_tool_access TO service_role;
REVOKE ALL ON public.user_tool_access FROM anon;

DROP POLICY IF EXISTS "user_tool_access_select" ON public.user_tool_access;
CREATE POLICY "user_tool_access_select" ON public.user_tool_access FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.auth_is_admin());

DROP POLICY IF EXISTS "user_tool_access_insert" ON public.user_tool_access;
CREATE POLICY "user_tool_access_insert" ON public.user_tool_access FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS "user_tool_access_update" ON public.user_tool_access;
CREATE POLICY "user_tool_access_update" ON public.user_tool_access FOR UPDATE TO authenticated
    USING (public.auth_is_admin())
    WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS "user_tool_access_delete" ON public.user_tool_access;
CREATE POLICY "user_tool_access_delete" ON public.user_tool_access FOR DELETE TO authenticated
    USING (public.auth_is_admin());

-- Realtime publication for immediate UI reaction when admin grants/revokes tool access
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'user_tool_access') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_tool_access;
  END IF;
END $$;
