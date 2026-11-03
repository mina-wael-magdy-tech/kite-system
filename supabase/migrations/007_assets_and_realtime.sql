-- ====================================================================
-- KITE SYSTEM — 007_assets_and_realtime.sql
--   1. General asset library (not tied to a task): private bucket + `assets` table.
--   2. Realtime streaming for the tables the app watches live.
-- Safe to run more than once.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Asset library
-- --------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('studio-assets', 'studio-assets', false, 52428800) -- 50 MB
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit;

CREATE TABLE IF NOT EXISTS public.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                      -- display name (editable)
    file_name TEXT NOT NULL,                 -- original file name
    file_size BIGINT NOT NULL CHECK (file_size > 0),
    file_type TEXT NOT NULL,
    storage_path TEXT NOT NULL UNIQUE,       -- <uploader id>/<random>-<file name>
    folder TEXT NOT NULL DEFAULT 'General',
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'studio' CHECK (visibility IN ('studio', 'department', 'private')),
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
    uploaded_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_folder ON public.assets(folder);
CREATE INDEX IF NOT EXISTS idx_assets_project ON public.assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_created ON public.assets(created_at DESC);

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO authenticated;

-- Who can see an asset: studio-wide ones, their own, their department's, and admins see everything.
DROP POLICY IF EXISTS "assets_select" ON public.assets;
CREATE POLICY "assets_select" ON public.assets FOR SELECT TO authenticated
    USING (
      public.auth_is_staff() AND (
        visibility = 'studio'
        OR uploaded_by = auth.uid()
        OR public.auth_is_admin()
        OR (visibility = 'department' AND EXISTS (
              SELECT 1 FROM public.user_departments ud
              WHERE ud.user_id = auth.uid() AND ud.department_id = assets.department_id))
      )
    );

DROP POLICY IF EXISTS "assets_insert" ON public.assets;
CREATE POLICY "assets_insert" ON public.assets FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_staff() AND uploaded_by = auth.uid());

DROP POLICY IF EXISTS "assets_update" ON public.assets;
CREATE POLICY "assets_update" ON public.assets FOR UPDATE TO authenticated
    USING (public.auth_is_staff() AND (uploaded_by = auth.uid() OR public.auth_is_admin()))
    WITH CHECK (public.auth_is_staff() AND (uploaded_by = auth.uid() OR public.auth_is_admin()));

DROP POLICY IF EXISTS "assets_delete" ON public.assets;
CREATE POLICY "assets_delete" ON public.assets FOR DELETE TO authenticated
    USING (public.auth_is_staff() AND (uploaded_by = auth.uid() OR public.auth_is_admin()));

-- keep updated_at fresh if the helper from 003 exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_assets_updated_at ON public.assets;
    CREATE TRIGGER trg_assets_updated_at BEFORE UPDATE ON public.assets
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- Storage objects: readable when the matching `assets` row is visible to the caller (its RLS applies);
-- uploads only into your own folder; deletes by the owner or an admin.
DROP POLICY IF EXISTS "studio_assets_read" ON storage.objects;
CREATE POLICY "studio_assets_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'studio-assets'
         AND EXISTS (SELECT 1 FROM public.assets a WHERE a.storage_path = name));

DROP POLICY IF EXISTS "studio_assets_upload" ON storage.objects;
CREATE POLICY "studio_assets_upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'studio-assets'
              AND public.auth_is_staff()
              AND split_part(name, '/', 1) = auth.uid()::text);

DROP POLICY IF EXISTS "studio_assets_delete" ON storage.objects;
CREATE POLICY "studio_assets_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'studio-assets'
         AND (owner_id = auth.uid()::text OR public.auth_is_admin()));

-- --------------------------------------------------------------------
-- 2. Realtime (RLS still decides what each person receives).
--    `profiles` is intentionally not streamed: it uses column-level grants.
-- --------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages', 'conversations', 'conversation_members', 'notifications',
    'tasks', 'task_comments', 'task_attachments', 'task_activity_logs',
    'projects', 'milestones', 'clients', 'leads', 'campaigns',
    'expenses', 'invoices', 'budgets', 'leave_requests', 'attendance_records',
    'departments', 'assets'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t)
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
