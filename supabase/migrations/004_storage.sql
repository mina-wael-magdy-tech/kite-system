-- ====================================================================
-- PULSE STUDIO OS — 004_storage.sql
-- Private storage for task deliverables. Access control only.
--
-- Object path convention:  <task_id>/<random>-<file name>
-- Access follows task visibility (public.auth_can_view_task).
-- Only the `task-attachments` bucket is created because it is the only one
-- the application uses. Add buckets here (never via the dashboard) when a
-- feature needs them.
-- ====================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('task-attachments', 'task-attachments', false, 26214400) -- 25 MB
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit;

-- Returns the task id encoded in the first path segment, or NULL if malformed.
-- Used only to keep policy expressions safe from invalid-uuid casts.
CREATE OR REPLACE FUNCTION public.storage_task_id(p_object_name TEXT)
RETURNS UUID LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN split_part(p_object_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN split_part(p_object_name, '/', 1)::uuid
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.storage_task_id(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.storage_task_id(TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "task_attachments_read" ON storage.objects;
CREATE POLICY "task_attachments_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'task-attachments'
         AND public.auth_can_view_task(public.storage_task_id(name)));

DROP POLICY IF EXISTS "task_attachments_upload" ON storage.objects;
CREATE POLICY "task_attachments_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'task-attachments'
              AND public.auth_can_view_task(public.storage_task_id(name)));

DROP POLICY IF EXISTS "task_attachments_delete" ON storage.objects;
CREATE POLICY "task_attachments_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'task-attachments'
         AND (owner_id = auth.uid()::text OR public.auth_is_admin()));
