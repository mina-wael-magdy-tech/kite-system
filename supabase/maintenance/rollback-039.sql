-- ====================================================================
-- Rollback for migration 039 (task_attachments_storage_guard)
-- ====================================================================
-- Restores: the 004 Storage policies, the 029 storage_cleanup_enqueue() and storage_cleanup_claim(), and removes the
-- 039 triggers, helper functions, unique index, storage_path_registry and storage_guard_settings.
-- The cleanup queue and every attachment row are left exactly as they are.
--
-- WARNING: this reopens the security hole 039 closes. It also DESTROYS the permanent path tombstones, so any path that
-- was ever deleted could be registered again. Because of that it refuses to run when the registry holds a dead path,
-- unless you confirm in the SAME session first:
--     SET kite.confirm_drop_storage_registry = 'yes';
--     \i supabase/maintenance/rollback-039.sql
-- Run it in one transaction-less psql session:  psql -v ON_ERROR_STOP=1 -f supabase/maintenance/rollback-039.sql
-- ====================================================================

DO $$
DECLARE v_dead BIGINT;
BEGIN
  IF to_regclass('public.storage_path_registry') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.storage_path_registry WHERE state = ''dead''' INTO v_dead;
    IF v_dead > 0 AND coalesce(current_setting('kite.confirm_drop_storage_registry', true), '') <> 'yes' THEN
      RAISE EXCEPTION 'rollback-039 refused: the registry holds % permanent tombstone(s) that this rollback would destroy. Run  SET kite.confirm_drop_storage_registry = ''yes'';  in this session to confirm.', v_dead;
    END IF;
  END IF;
END $$;

-- 1. Storage policies back to 004
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

-- 2. Triggers, then the functions they used
DROP TRIGGER IF EXISTS task_attachments_path_guard ON public.task_attachments;
DROP FUNCTION IF EXISTS public.task_attachments_path_guard();
DROP INDEX IF EXISTS public.idx_task_attachments_storage_path_key;

-- 3. 029 bodies of the shared cleanup functions
CREATE OR REPLACE FUNCTION public.storage_cleanup_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_path TEXT; v_bucket TEXT := TG_ARGV[0];
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    v_path := OLD.metadata ->> 'path';
    IF v_path IS NULL OR left(v_path, length(OLD.conversation_id::text) + 1) <> OLD.conversation_id::text || '/' THEN RETURN OLD; END IF;
  ELSE
    v_path := OLD.storage_path;
  END IF;
  IF coalesce(v_path, '') <> '' THEN
    INSERT INTO public.storage_cleanup_queue (bucket, path, source) VALUES (v_bucket, v_path, TG_TABLE_NAME)
    ON CONFLICT (bucket, path) WHERE done_at IS NULL DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.storage_cleanup_enqueue() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.storage_cleanup_claim(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (id BIGINT, bucket TEXT, path TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  WITH c AS (
    SELECT q.id FROM public.storage_cleanup_queue q
    WHERE q.done_at IS NULL AND q.next_attempt_at <= now() AND q.attempts < 12
    ORDER BY q.next_attempt_at, q.id LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
    FOR UPDATE SKIP LOCKED)
  UPDATE public.storage_cleanup_queue q SET attempts = q.attempts + 1, last_attempt_at = now(), next_attempt_at = now() + interval '10 minutes'
  FROM c WHERE q.id = c.id
  RETURNING q.id, q.bucket, q.path;
$$;
REVOKE ALL ON FUNCTION public.storage_cleanup_claim(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_cleanup_claim(INTEGER) TO service_role;

-- 4. Registry, switch table and helpers (policies no longer reference them)
DROP TRIGGER IF EXISTS storage_path_registry_guard_row ON public.storage_path_registry;
DROP TRIGGER IF EXISTS storage_path_registry_guard_truncate ON public.storage_path_registry;
DROP TABLE IF EXISTS public.storage_path_registry;
DROP FUNCTION IF EXISTS public.storage_path_registry_guard();
DROP TABLE IF EXISTS public.storage_guard_settings;
DROP FUNCTION IF EXISTS public.storage_guard_enabled(TEXT);
DROP FUNCTION IF EXISTS public.task_attachment_path_uid(TEXT);
DROP FUNCTION IF EXISTS public.task_attachment_path_kind(TEXT);
