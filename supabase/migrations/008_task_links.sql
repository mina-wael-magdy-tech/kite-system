-- ====================================================================
-- KITE SYSTEM — 008_task_links.sql
-- Reference links attached to a task (Drive / Figma / Dropbox / brief URLs).
-- Visible to everyone who can see the task; added by them; removed by the author or an admin.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.task_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL CHECK (url ~* '^https?://'),
    added_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_links_task ON public.task_links(task_id);

ALTER TABLE public.task_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.task_links TO authenticated;

DROP POLICY IF EXISTS "task_links_select" ON public.task_links;
CREATE POLICY "task_links_select" ON public.task_links FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_links_insert" ON public.task_links;
CREATE POLICY "task_links_insert" ON public.task_links FOR INSERT TO authenticated
    WITH CHECK (added_by = auth.uid() AND public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_links_delete" ON public.task_links;
CREATE POLICY "task_links_delete" ON public.task_links FOR DELETE TO authenticated
    USING (added_by = auth.uid() OR public.auth_is_admin());

-- live updates
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'task_links') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_links;
  END IF;
END $$;
