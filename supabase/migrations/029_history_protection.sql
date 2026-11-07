-- ====================================================================
-- KITE SYSTEM — 029_history_protection.sql   (Phase 3.B: F-02, F-08, F-19)
--
--   F-02  An employee who has history (attendance, leave, chat messages, HR documents, task comments / time entries,
--         audit or activity records, finance attribution) can no longer be hard-deleted: deactivate them instead.
--         A tombstone row (deleted_users) is written for every profile that IS deleted, and audit_logs /
--         task_activity_logs keep WHO acted (actor_id + actor_label) even after the profile is gone.
--   F-08  tasks, projects, clients, departments and campaigns with business or financial history cannot be deleted
--         (deletion_blockers() lists why); archive them instead (status inactive / is_archived / is_active = false /
--         status cancelled). The error never reveals finance details to non-executives.
--   F-19  Storage clean-up is queued IN THE SAME TRANSACTION as the row delete (storage_cleanup_queue), so a file is
--         never removed before its row, a failed removal is retried (never silently lost), and a cascade (plan -> posts
--         -> assets) queues every file. storage_cleanup_claim / _report are the worker's two calls.
--
-- Also installs ops_add_check(): the NOT VALID -> validate-if-clean helper used by migrations 029-033.
-- Nothing historical is deleted. The only rows written are the NEW actor_id / actor_label annotation columns of
-- audit_logs and task_activity_logs (derived from user_id, which is left untouched).
-- Safe to run more than once. Run AFTER 028. Applied manually; never `db push` on live.
--
-- ROLLBACK (data stays; only protections go):
--   DROP TRIGGER IF EXISTS profiles_a_history_guard ON public.profiles;  DROP TRIGGER IF EXISTS profiles_b_tombstone ON public.profiles;
--   DROP TRIGGER IF EXISTS tasks_history_guard ON public.tasks;      DROP TRIGGER IF EXISTS projects_history_guard ON public.projects;
--   DROP TRIGGER IF EXISTS clients_history_guard ON public.clients;  DROP TRIGGER IF EXISTS departments_history_guard ON public.departments;
--   DROP TRIGGER IF EXISTS campaigns_history_guard ON public.campaigns;
--   DROP TRIGGER IF EXISTS storage_queue_task_attachments ON public.task_attachments; DROP TRIGGER IF EXISTS storage_queue_assets ON public.assets;
--   DROP TRIGGER IF EXISTS storage_queue_plan_assets ON public.content_post_assets;   DROP TRIGGER IF EXISTS storage_queue_messages ON public.messages;
--   DROP TRIGGER IF EXISTS audit_actor_fill ON public.audit_logs;    DROP TRIGGER IF EXISTS activity_actor_fill ON public.task_activity_logs;
--   DROP FUNCTION IF EXISTS public.profiles_history_guard(), public.profiles_tombstone(), public.history_guard(),
--     public.deletion_blockers(text, uuid), public.employee_history(uuid), public.storage_cleanup_enqueue(),
--     public.storage_cleanup_claim(integer), public.storage_cleanup_report(bigint, boolean, text), public.storage_cleanup_status(),
--     public.audit_actor_fill(), public.ops_add_check(regclass, text, text);
--   -- optional, only if you also want the data structures gone (the queue may hold files still to be removed!):
--   --   DROP TABLE public.storage_cleanup_queue;  DROP TABLE public.deleted_users;
--   --   ALTER TABLE public.audit_logs DROP COLUMN actor_id, DROP COLUMN actor_label;
--   --   ALTER TABLE public.task_activity_logs DROP COLUMN actor_id, DROP COLUMN actor_label;
-- ====================================================================

-- ---------------------------------------------------------------- 0. helper: add a CHECK, validate it only if the data complies
CREATE OR REPLACE FUNCTION public.ops_add_check(p_table REGCLASS, p_name TEXT, p_expr TEXT)
RETURNS TEXT LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_bad BIGINT; v_valid BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p_name AND conrelid = p_table) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', p_table, p_name, p_expr);
  END IF;
  SELECT convalidated INTO v_valid FROM pg_constraint WHERE conname = p_name AND conrelid = p_table;
  IF v_valid THEN RETURN 'valid'; END IF;
  EXECUTE format('SELECT count(*) FROM %s WHERE NOT coalesce(%s, false)', p_table, p_expr) INTO v_bad;
  IF v_bad = 0 THEN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', p_table, p_name);
    RETURN 'valid';
  END IF;
  RAISE NOTICE '%: % existing row(s) of % violate it; it stays NOT VALID (enforced for new writes only). Clean the data, then re-run the migration.', p_name, v_bad, p_table;
  RETURN 'not valid (' || v_bad || ' rows)';
END;
$$;
REVOKE ALL ON FUNCTION public.ops_add_check(REGCLASS, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 1. tombstones + attribution that survives a profile delete
CREATE TABLE IF NOT EXISTS public.deleted_users (
    id UUID PRIMARY KEY,
    email TEXT,
    full_name TEXT,
    employee_id TEXT,
    job_title TEXT,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_by UUID,
    snapshot JSONB
);
ALTER TABLE public.deleted_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_users FROM anon, authenticated;
GRANT SELECT ON public.deleted_users TO authenticated;
DROP POLICY IF EXISTS "deleted_users_select" ON public.deleted_users;
CREATE POLICY "deleted_users_select" ON public.deleted_users FOR SELECT TO authenticated USING (public.auth_is_admin());

ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_id UUID, ADD COLUMN IF NOT EXISTS actor_label TEXT;
ALTER TABLE public.task_activity_logs ADD COLUMN IF NOT EXISTS actor_id UUID, ADD COLUMN IF NOT EXISTS actor_label TEXT;

CREATE OR REPLACE FUNCTION public.audit_actor_fill()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_id IS NULL AND NEW.user_id IS NOT NULL THEN
    NEW.actor_id := NEW.user_id;
    SELECT coalesce(p.full_name, p.email) INTO NEW.actor_label FROM public.profiles p WHERE p.id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_actor_fill() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS audit_actor_fill ON public.audit_logs;
CREATE TRIGGER audit_actor_fill BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_actor_fill();
DROP TRIGGER IF EXISTS activity_actor_fill ON public.task_activity_logs;
CREATE TRIGGER activity_actor_fill BEFORE INSERT ON public.task_activity_logs FOR EACH ROW EXECUTE FUNCTION public.audit_actor_fill();

-- annotate the existing rows once (new columns only; user_id and every original column are untouched)
UPDATE public.audit_logs a SET actor_id = a.user_id, actor_label = (SELECT coalesce(p.full_name, p.email) FROM public.profiles p WHERE p.id = a.user_id)
 WHERE a.actor_id IS NULL AND a.user_id IS NOT NULL;
UPDATE public.task_activity_logs a SET actor_id = a.user_id, actor_label = (SELECT coalesce(p.full_name, p.email) FROM public.profiles p WHERE p.id = a.user_id)
 WHERE a.actor_id IS NULL AND a.user_id IS NOT NULL;

-- ---------------------------------------------------------------- 2. F-02: an employee with history cannot be hard-deleted
CREATE OR REPLACE FUNCTION public.employee_history(p_user UUID)
RETURNS TABLE (source TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s, c FROM (
    SELECT 'attendance'::text s, count(*) c FROM public.attendance_records WHERE user_id = p_user
    UNION ALL SELECT 'leave requests', count(*) FROM public.leave_requests WHERE user_id = p_user
    UNION ALL SELECT 'chat messages', count(*) FROM public.messages WHERE sender_id = p_user
    UNION ALL SELECT 'HR documents', count(*) FROM public.employee_documents WHERE user_id = p_user
    UNION ALL SELECT 'task comments', count(*) FROM public.task_comments WHERE user_id = p_user
    UNION ALL SELECT 'time entries', count(*) FROM public.task_time_entries WHERE user_id = p_user
    UNION ALL SELECT 'audit records', count(*) FROM public.audit_logs WHERE user_id = p_user OR actor_id = p_user
    UNION ALL SELECT 'task activity', count(*) FROM public.task_activity_logs WHERE user_id = p_user OR actor_id = p_user
    UNION ALL SELECT 'finance audit', count(*) FROM public.finance_audit_log WHERE actor = p_user
    UNION ALL SELECT 'expenses', count(*) FROM public.expenses WHERE submitted_by = p_user
    UNION ALL SELECT 'tasks created', count(*) FROM public.tasks WHERE created_by = p_user
  ) x WHERE c > 0;
$$;
REVOKE ALL ON FUNCTION public.employee_history(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_history(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.profiles_history_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_what TEXT;
BEGIN
  SELECT string_agg(source, ', ' ORDER BY source) INTO v_what FROM public.employee_history(OLD.id);
  IF v_what IS NOT NULL THEN
    RAISE EXCEPTION 'employee_has_history: this employee has history (%) and cannot be deleted. Set their status to Inactive instead.', v_what
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.profiles_history_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.profiles_tombstone()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.deleted_users (id, email, full_name, employee_id, job_title, deleted_by, snapshot)
  VALUES (OLD.id, OLD.email, OLD.full_name, OLD.employee_id, OLD.job_title,
          coalesce(nullif(current_setting('app.actor', true), '')::uuid, auth.uid()), to_jsonb(OLD))
  ON CONFLICT (id) DO NOTHING;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.profiles_tombstone() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS profiles_a_history_guard ON public.profiles;
CREATE TRIGGER profiles_a_history_guard BEFORE DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_history_guard();
DROP TRIGGER IF EXISTS profiles_b_tombstone ON public.profiles;
CREATE TRIGGER profiles_b_tombstone BEFORE DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_tombstone();

-- ---------------------------------------------------------------- 3. F-08: business records with history cannot be deleted
-- Returns the reasons (with counts) a record may not be deleted; empty = deletable. service_role only (counts of finance rows stay private).
-- A plan number in money_figures (budget / monthly figure) is NOT history: 032 deletes it together with its record.
CREATE OR REPLACE FUNCTION public.deletion_blockers(p_entity TEXT, p_id UUID)
RETURNS TEXT[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v TEXT[] := '{}'; n BIGINT;
BEGIN
  IF p_entity = 'task' THEN
    SELECT count(*) INTO n FROM public.invoices WHERE task_id = p_id;                 IF n > 0 THEN v := v || ('invoices: ' || n); END IF;
    SELECT count(*) INTO n FROM public.task_time_entries WHERE task_id = p_id;        IF n > 0 THEN v := v || ('time entries: ' || n); END IF;
  ELSIF p_entity = 'project' THEN
    SELECT count(*) INTO n FROM public.invoices WHERE project_id = p_id;              IF n > 0 THEN v := v || ('invoices: ' || n); END IF;
    SELECT count(*) INTO n FROM public.expenses WHERE project_id = p_id;              IF n > 0 THEN v := v || ('expenses: ' || n); END IF;
    SELECT count(*) INTO n FROM public.budgets WHERE project_id = p_id;               IF n > 0 THEN v := v || ('budgets: ' || n); END IF;
  ELSIF p_entity = 'client' THEN
    SELECT count(*) INTO n FROM public.invoices WHERE client_id = p_id;               IF n > 0 THEN v := v || ('invoices: ' || n); END IF;
    SELECT count(*) INTO n FROM public.retainer_plans WHERE client_id = p_id;         IF n > 0 THEN v := v || ('retainer plans: ' || n); END IF;
  ELSIF p_entity = 'department' THEN
    SELECT count(*) INTO n FROM public.budgets WHERE department_id = p_id;            IF n > 0 THEN v := v || ('budgets: ' || n); END IF;
    SELECT count(*) INTO n FROM public.invoices WHERE department_id = p_id;           IF n > 0 THEN v := v || ('invoices: ' || n); END IF;
    SELECT count(*) INTO n FROM public.retainer_plans WHERE department_id = p_id;     IF n > 0 THEN v := v || ('retainer plans: ' || n); END IF;
    SELECT count(*) INTO n FROM public.expenses WHERE department_id = p_id;           IF n > 0 THEN v := v || ('expenses: ' || n); END IF;
  END IF;   -- campaigns carry no financial history of their own (their budget figure is a plan number; 032 removes it with the campaign)
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.deletion_blockers(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deletion_blockers(TEXT, UUID) TO service_role;

-- one generic trigger function; TG_ARGV[0] = entity name, TG_ARGV[1] = how to archive (shown to the user)
CREATE OR REPLACE FUNCTION public.history_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF cardinality(public.deletion_blockers(TG_ARGV[0], OLD.id)) > 0 THEN
    RAISE EXCEPTION 'record_has_history: this % has financial or work history and cannot be deleted. %', TG_ARGV[0], TG_ARGV[1]
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.history_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tasks_history_guard ON public.tasks;
CREATE TRIGGER tasks_history_guard BEFORE DELETE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.history_guard('task', 'Cancel it instead (status Cancelled).');
DROP TRIGGER IF EXISTS projects_history_guard ON public.projects;
CREATE TRIGGER projects_history_guard BEFORE DELETE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.history_guard('project', 'Archive it instead.');
DROP TRIGGER IF EXISTS clients_history_guard ON public.clients;
CREATE TRIGGER clients_history_guard BEFORE DELETE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.history_guard('client', 'Set its status to Inactive instead.');
DROP TRIGGER IF EXISTS departments_history_guard ON public.departments;
CREATE TRIGGER departments_history_guard BEFORE DELETE ON public.departments FOR EACH ROW EXECUTE FUNCTION public.history_guard('department', 'Deactivate it instead.');
DROP TRIGGER IF EXISTS campaigns_history_guard ON public.campaigns;
CREATE TRIGGER campaigns_history_guard BEFORE DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.history_guard('campaign', 'Set its status to Cancelled or Completed instead.');

-- ---------------------------------------------------------------- 4. F-19: storage clean-up queue (queued in the SAME transaction as the delete)
CREATE TABLE IF NOT EXISTS public.storage_cleanup_queue (
    id BIGSERIAL PRIMARY KEY,
    bucket TEXT NOT NULL,
    path TEXT NOT NULL CHECK (path <> ''),
    source TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    done_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_cleanup_open ON public.storage_cleanup_queue (bucket, path) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_due ON public.storage_cleanup_queue (next_attempt_at) WHERE done_at IS NULL;
ALTER TABLE public.storage_cleanup_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_cleanup_queue FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.storage_cleanup_queue_id_seq FROM anon, authenticated;

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
DROP TRIGGER IF EXISTS storage_queue_task_attachments ON public.task_attachments;
CREATE TRIGGER storage_queue_task_attachments AFTER DELETE ON public.task_attachments FOR EACH ROW EXECUTE FUNCTION public.storage_cleanup_enqueue('task-attachments');
DROP TRIGGER IF EXISTS storage_queue_assets ON public.assets;
CREATE TRIGGER storage_queue_assets AFTER DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.storage_cleanup_enqueue('studio-assets');
DROP TRIGGER IF EXISTS storage_queue_plan_assets ON public.content_post_assets;
CREATE TRIGGER storage_queue_plan_assets AFTER DELETE ON public.content_post_assets FOR EACH ROW EXECUTE FUNCTION public.storage_cleanup_enqueue('studio-assets');
DROP TRIGGER IF EXISTS storage_queue_messages ON public.messages;
CREATE TRIGGER storage_queue_messages AFTER DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.storage_cleanup_enqueue('chat-media');

-- The worker claims a batch (a 10-minute lease, so two workers never take the same row), removes the objects, then reports.
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
CREATE OR REPLACE FUNCTION public.storage_cleanup_report(p_id BIGINT, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE public.storage_cleanup_queue SET
    done_at = CASE WHEN p_ok THEN now() ELSE NULL END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(coalesce(p_error, 'unknown error'), 500) END,
    next_attempt_at = CASE WHEN p_ok THEN next_attempt_at ELSE now() + least(attempts, 24) * interval '1 hour' END
  WHERE id = p_id AND done_at IS NULL;
$$;
-- open work, and rows that gave up (attempts >= 12): these need a person
CREATE OR REPLACE FUNCTION public.storage_cleanup_status()
RETURNS TABLE (pending BIGINT, failing BIGINT, gave_up BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT count(*) FILTER (WHERE done_at IS NULL), count(*) FILTER (WHERE done_at IS NULL AND last_error IS NOT NULL),
         count(*) FILTER (WHERE done_at IS NULL AND attempts >= 12) FROM public.storage_cleanup_queue;
$$;
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['storage_cleanup_claim(integer)', 'storage_cleanup_report(bigint,boolean,text)', 'storage_cleanup_status()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
