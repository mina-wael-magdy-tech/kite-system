-- ====================================================================
-- 039  Task attachments: storage path ownership, permanent path registry, cleanup-queue gate
--      (additive, idempotent, reversible: supabase/maintenance/rollback-039.sql)
-- ====================================================================
-- THE ATTACK (finding storage:task-attachments:arbitrary-file-deletion-cleanup)
--   Any authenticated user who can see a task could INSERT a task_attachments row whose storage_path points at someone
--   else's object (a file still being attached, or an orphan), then DELETE the row. The delete queued the path in
--   storage_cleanup_queue and the service-role worker removed the victim's file, bypassing Storage RLS.
--   Related holes closed here: (1) a path that is pending/completed in the cleanup queue could be registered again,
--   (2) any task viewer could LIST other users' unattached objects, (3) the DB path check allowed spaces, newlines,
--   quotes, and its backslash test was a no-op.
--
-- DESIGN
--   1. UPLOADER-BOUND PATH. New uploads use   <task_id>/<uploader_id>-<file_uuid>-<name>
--        name = 1..120 characters of [A-Za-z0-9_.-]  (exactly what the frontend's  name.replace(/[^\w.\-]+/g,'_').slice(-120)  produces;
--        PostgreSQL \w is locale-aware, so explicit ASCII ranges are used instead).
--      Storage RLS INSERT requires the uploader_id segment to equal auth.uid(); the attachments trigger requires it to
--      equal uploaded_by (which RLS forces to auth.uid()). Ownership is therefore proven by the platform's policy on the
--      object name, not by UUID entropy and not by storage.objects.owner_id.
--   2. PERMANENT PATH REGISTRY  public.storage_path_registry  (PK bucket,path; rows are never deleted).
--      A path can be registered ONCE in its lifetime: state 'live' while its attachment exists, 'dead' forever after.
--      The primary key is the arbiter, so concurrent INSERT/DELETE races are decided by PostgreSQL's unique-index wait
--      (works under READ COMMITTED, REPEATABLE READ and SERIALIZABLE). No advisory locks, no snapshot reasoning.
--   3. QUEUE ONLY VIA TRANSITION. storage_cleanup_enqueue() queues a task-attachments path only when it flips the
--      registry row live -> dead for exactly that attachment. storage_cleanup_claim() hands a task-attachments row to
--      the worker only when its registry row is 'dead'. Forged or legacy-residue queue rows never reach the service role.
--   4. STORAGE RLS (replaces 004):  INSERT only into your own uploader namespace; SELECT only attached files, your own
--      pending files, or (admin) everything; DELETE own namespace / owner_id / admin.
--   5. TWO-STAGE TRANSITION (Decision 1). Stage 1 (this migration): the legacy path format <task_id>/<file_uuid>-<name>
--      is REFUSED unless public.storage_guard_settings('task_attachments_legacy_paths') is switched on, and even then a
--      legacy registration needs a storage.objects row whose owner_id = uploaded_by (fail closed). Whether owner_id is
--      reliably populated on the live project is NOT verified (see the staging checklist), so the switch ships OFF:
--      a controlled hard cutover; stale browser tabs get "Legacy upload path is no longer accepted. Please refresh the
--      page and upload again.". Stage 2 (a later migration) deletes the legacy branch and the switch.
--      Existing rows keep their legacy paths: they stay readable and deletable; only NEW registrations are constrained.
--
-- READ-ONLY DIAGNOSTICS to run BEFORE applying on a real database:
--   SELECT storage_path, count(*) FROM public.task_attachments GROUP BY 1 HAVING count(*) > 1;      -- must be empty
--   SELECT id, task_id, storage_path FROM public.task_attachments
--    WHERE storage_path !~ ('^' || task_id::text || '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[^/\\[:cntrl:]]+$');
--       -- rows listed here are registered as live but NOT deletable-by-queue (their file is never auto-removed)
--   SELECT q.id, q.path, q.done_at FROM public.storage_cleanup_queue q
--    WHERE q.bucket = 'task-attachments' AND EXISTS (SELECT 1 FROM public.task_attachments a WHERE a.storage_path = q.path);
--       -- queued AND still referenced: possible exploit residue; the migration quarantines open ones (attempts = 12)
--
-- ROLLBACK: psql -v ON_ERROR_STOP=1 -f supabase/maintenance/rollback-039.sql   (read its header first)
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Switch table (Stage 1 legacy-path switch, default OFF)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.storage_guard_settings (
  key     TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  note    TEXT
);
ALTER TABLE public.storage_guard_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_guard_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.storage_guard_settings (key, enabled, note)
VALUES ('task_attachments_legacy_paths', false,
        'Stage 1 only. true = accept legacy <task_id>/<file_uuid>-<name> uploads whose storage.objects.owner_id equals the uploader. Verify owner_id population on staging first. Removed in Stage 2.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.storage_guard_enabled(p_key TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT coalesce((SELECT s.enabled FROM public.storage_guard_settings s WHERE s.key = p_key), false); $$;
REVOKE ALL ON FUNCTION public.storage_guard_enabled(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.storage_guard_enabled(TEXT) TO authenticated, service_role;

-- --------------------------------------------------------------------
-- 2. Path format helpers (pure, shared by the triggers and by Storage RLS)
-- --------------------------------------------------------------------
-- 'bound'  : <task_id>/<uploader_id>-<file_uuid>-<[A-Za-z0-9_.-]{1,120}>
-- 'legacy' : <task_id>/<file_uuid>-<[A-Za-z0-9_.-]{1,120}>          (a path starting <task>/<uuid>-<uuid>- is never 'legacy')
CREATE OR REPLACE FUNCTION public.task_attachment_path_kind(p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[A-Za-z0-9_.-]{1,120}$' THEN 'bound'
    WHEN p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[A-Za-z0-9_.-]{1,120}$'
         AND p_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-' THEN 'legacy'   -- a bound-shaped prefix (even with an empty name) is never legacy
    ELSE NULL
  END;
$$;

-- the uploader a bound path belongs to (NULL for anything else)
CREATE OR REPLACE FUNCTION public.task_attachment_path_uid(p_name TEXT)
RETURNS UUID LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE WHEN public.task_attachment_path_kind(p_name) = 'bound'
              THEN substr(split_part(p_name, '/', 2), 1, 36)::uuid END;
$$;
REVOKE ALL ON FUNCTION public.task_attachment_path_kind(TEXT), public.task_attachment_path_uid(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_attachment_path_kind(TEXT), public.task_attachment_path_uid(TEXT) TO authenticated, service_role;

-- --------------------------------------------------------------------
-- 3. Permanent path registry
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.storage_path_registry (
  bucket        TEXT NOT NULL,
  path          TEXT NOT NULL CHECK (path <> ''),
  state         TEXT NOT NULL CHECK (state IN ('live', 'dead')),
  owner_id      UUID,
  task_id       UUID,
  attachment_id UUID,
  deletable     BOOLEAN NOT NULL DEFAULT true,   -- false: legacy non-canonical path, its file is never auto-queued
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead_at       TIMESTAMPTZ,
  PRIMARY KEY (bucket, path),
  CHECK ((state = 'dead') = (dead_at IS NOT NULL))
);
ALTER TABLE public.storage_path_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_path_registry FROM PUBLIC, anon, authenticated;

-- tombstones are permanent: no DELETE, no TRUNCATE, and the only UPDATE allowed is live -> dead
CREATE OR REPLACE FUNCTION public.storage_path_registry_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'live' AND NEW.state = 'dead'
       AND (NEW.bucket, NEW.path, NEW.owner_id, NEW.task_id, NEW.attachment_id, NEW.deletable, NEW.registered_at)
           IS NOT DISTINCT FROM (OLD.bucket, OLD.path, OLD.owner_id, OLD.task_id, OLD.attachment_id, OLD.deletable, OLD.registered_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'storage_path_registry rows are permanent: only live -> dead is allowed';
  END IF;
  RAISE EXCEPTION 'storage_path_registry rows are permanent and cannot be deleted';
END;
$$;
REVOKE ALL ON FUNCTION public.storage_path_registry_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS storage_path_registry_guard_row ON public.storage_path_registry;
CREATE TRIGGER storage_path_registry_guard_row BEFORE UPDATE OR DELETE ON public.storage_path_registry
  FOR EACH ROW EXECUTE FUNCTION public.storage_path_registry_guard();
DROP TRIGGER IF EXISTS storage_path_registry_guard_truncate ON public.storage_path_registry;
CREATE TRIGGER storage_path_registry_guard_truncate BEFORE TRUNCATE ON public.storage_path_registry
  FOR EACH STATEMENT EXECUTE FUNCTION public.storage_path_registry_guard();

-- --------------------------------------------------------------------
-- 4. Backfill (idempotent). Refuses to guess on duplicate paths.
-- --------------------------------------------------------------------
DO $$
DECLARE v_dups INT;
BEGIN
  SELECT count(*) INTO v_dups FROM (SELECT storage_path FROM public.task_attachments GROUP BY storage_path HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '039 aborted: % storage_path value(s) are referenced by more than one task_attachments row. Resolve them by hand (see the diagnostics in the header).', v_dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attachments_storage_path_key ON public.task_attachments (storage_path);

-- every existing attachment is a live registration; only canonical legacy paths are deletable-by-queue
INSERT INTO public.storage_path_registry (bucket, path, state, owner_id, task_id, attachment_id, deletable)
SELECT 'task-attachments', a.storage_path, 'live', a.uploaded_by, a.task_id, a.id,
       (a.storage_path ~ ('^' || a.task_id::text || '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[^/\\[:cntrl:]]+$'))
FROM public.task_attachments a
WHERE coalesce(a.storage_path, '') <> ''
ON CONFLICT (bucket, path) DO NOTHING;

-- every path already in the cleanup queue (open or done) becomes a permanent tombstone, unless a live attachment owns it
INSERT INTO public.storage_path_registry (bucket, path, state, dead_at, deletable)
SELECT DISTINCT 'task-attachments', q.path, 'dead', now(), true
FROM public.storage_cleanup_queue q
WHERE q.bucket = 'task-attachments'
  AND q.path ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-[^/\\[:cntrl:]]+$'
ON CONFLICT (bucket, path) DO NOTHING;

-- open queue rows without a dead tombstone (still referenced by a live attachment, or not a canonical path):
-- quarantined for a person. attempts = 12 shows in storage_cleanup_status().gave_up; the claim gate keeps them from the worker.
UPDATE public.storage_cleanup_queue q
SET attempts = 12,
    last_error = 'quarantined by 039: path is referenced by a live attachment or is not a canonical task-attachments path'
WHERE q.bucket = 'task-attachments' AND q.done_at IS NULL AND q.attempts < 12
  AND NOT EXISTS (SELECT 1 FROM public.storage_path_registry r WHERE r.bucket = q.bucket AND r.path = q.path AND r.state = 'dead');

-- --------------------------------------------------------------------
-- 5. BEFORE INSERT OR UPDATE guard on task_attachments
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.task_attachments_path_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.storage_path IS DISTINCT FROM OLD.storage_path THEN
      RAISE EXCEPTION 'Task attachment storage path cannot be changed';
    END IF;
    IF NEW.task_id IS DISTINCT FROM OLD.task_id THEN
      RAISE EXCEPTION 'Task attachment cannot move to another task';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.storage_path IS NULL OR trim(NEW.storage_path) = '' THEN
    RAISE EXCEPTION 'Task attachment storage path cannot be null or empty';
  END IF;

  v_kind := public.task_attachment_path_kind(NEW.storage_path);
  IF v_kind IS NULL OR lower(split_part(NEW.storage_path, '/', 1)) <> NEW.task_id::text THEN
    RAISE EXCEPTION 'Task attachment storage path must follow <task_id>/<uploader_id>-<file_uuid>-<name> (name: 1-120 of A-Z a-z 0-9 _ . -) for task %', NEW.task_id;
  END IF;

  IF v_kind = 'bound' THEN
    IF public.task_attachment_path_uid(NEW.storage_path) IS DISTINCT FROM NEW.uploaded_by THEN
      RAISE EXCEPTION 'Task attachment storage path belongs to another uploader';
    END IF;
  ELSE
    -- legacy format: Stage 1 switch, then verified ownership of the stored object; fail closed in every other case
    IF NOT public.storage_guard_enabled('task_attachments_legacy_paths') THEN
      RAISE EXCEPTION 'Legacy upload path is no longer accepted. Please refresh the page and upload again.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o
                   WHERE o.bucket_id = 'task-attachments' AND o.name = NEW.storage_path AND o.owner_id = NEW.uploaded_by::text) THEN
      RAISE EXCEPTION 'Ownership of the uploaded file could not be verified. Please upload it again.';
    END IF;
  END IF;

  -- atomic one-time registration: ANY existing registry row (live or dead) refuses the path, forever
  INSERT INTO public.storage_path_registry (bucket, path, state, owner_id, task_id, attachment_id, deletable)
  VALUES ('task-attachments', NEW.storage_path, 'live', NEW.uploaded_by, NEW.task_id, NEW.id, true)
  ON CONFLICT (bucket, path) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task attachment storage path was already used and cannot be registered again: %', NEW.storage_path
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.task_attachments_path_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS task_attachments_path_guard ON public.task_attachments;
CREATE TRIGGER task_attachments_path_guard
  BEFORE INSERT OR UPDATE ON public.task_attachments
  FOR EACH ROW EXECUTE FUNCTION public.task_attachments_path_guard();

-- --------------------------------------------------------------------
-- 6. storage_cleanup_enqueue(): task-attachments queue ONLY through the live -> dead transition
--    (messages / assets / content_post_assets behave exactly as in 029)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storage_cleanup_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_path TEXT;
  v_bucket TEXT := TG_ARGV[0];
  v_deletable BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    v_path := OLD.metadata ->> 'path';
    IF v_path IS NULL OR left(v_path, length(OLD.conversation_id::text) + 1) <> OLD.conversation_id::text || '/' THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME = 'task_attachments' THEN
    -- the row lock taken here makes a concurrent registration of the same path wait, then be refused
    UPDATE public.storage_path_registry r
       SET state = 'dead', dead_at = now()
     WHERE r.bucket = 'task-attachments' AND r.path = OLD.storage_path
       AND r.attachment_id = OLD.id AND r.state = 'live'
    RETURNING r.deletable INTO v_deletable;
    IF NOT FOUND OR NOT v_deletable THEN RETURN OLD; END IF;
    v_path := OLD.storage_path;
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

-- --------------------------------------------------------------------
-- 7. storage_cleanup_claim(): a task-attachments row leaves the database only when its path is a dead tombstone
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storage_cleanup_claim(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (id BIGINT, bucket TEXT, path TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  WITH c AS (
    SELECT q.id FROM public.storage_cleanup_queue q
    WHERE q.done_at IS NULL AND q.next_attempt_at <= now() AND q.attempts < 12
      AND (q.bucket <> 'task-attachments'
           OR EXISTS (SELECT 1 FROM public.storage_path_registry r WHERE r.bucket = q.bucket AND r.path = q.path AND r.state = 'dead'))
    ORDER BY q.next_attempt_at, q.id LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
    FOR UPDATE SKIP LOCKED)
  UPDATE public.storage_cleanup_queue q SET attempts = q.attempts + 1, last_attempt_at = now(), next_attempt_at = now() + interval '10 minutes'
  FROM c WHERE q.id = c.id
  RETURNING q.id, q.bucket, q.path;
$$;
REVOKE ALL ON FUNCTION public.storage_cleanup_claim(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_cleanup_claim(INTEGER) TO service_role;

-- --------------------------------------------------------------------
-- 8. Storage RLS for the task-attachments bucket (replaces 004)
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "task_attachments_read" ON storage.objects;
CREATE POLICY "task_attachments_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'task-attachments'
         AND public.auth_can_view_task(public.storage_task_id(name))
         AND (EXISTS (SELECT 1 FROM public.task_attachments a WHERE a.storage_path = name)   -- attached
              OR public.task_attachment_path_uid(name) = (SELECT auth.uid())                  -- my own pending upload
              OR owner_id = (SELECT auth.uid())::text                                         -- my own legacy upload
              OR (SELECT public.auth_is_admin())));

DROP POLICY IF EXISTS "task_attachments_upload" ON storage.objects;
CREATE POLICY "task_attachments_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'task-attachments'
              AND public.auth_can_view_task(public.storage_task_id(name))
              AND (public.task_attachment_path_uid(name) = (SELECT auth.uid())
                   OR (public.task_attachment_path_kind(name) = 'legacy'
                       AND public.storage_guard_enabled('task_attachments_legacy_paths'))));

DROP POLICY IF EXISTS "task_attachments_delete" ON storage.objects;
CREATE POLICY "task_attachments_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'task-attachments'
         AND (public.task_attachment_path_uid(name) = (SELECT auth.uid())
              OR owner_id = (SELECT auth.uid())::text
              OR (SELECT public.auth_is_admin())));
