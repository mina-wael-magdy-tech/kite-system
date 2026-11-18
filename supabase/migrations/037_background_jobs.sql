-- ====================================================================
-- 037  Phase 7: background processing and data lifecycle                     (additive, idempotent, reversible)
-- ====================================================================
--   P7-02  due_digest_batch() / publish_digest_batch(): set-based, keyset-paged digest candidates. They replace two reads that
--          PostgREST silently capped at 1,000 rows. Same eligibility as before (assigned, open, due by tomorrow, active person, not
--          already reminded in the last 20 hours / today's dedupe key).
--   P7-03  Digest work is done in bounded batches; a person who already has today's digest is never a candidate again, so a run that
--          stopped early is resumed simply by running again.
--   P7-04  job_runs ledger (job_run_start / job_run_progress / job_run_finish), job_status(), job_missed_runs(). READ-ONLY detectors:
--          nothing here sends an alert and no threshold is built in (the caller passes the age).
--   P7-05  broadcast_claim() / broadcast_finish(): a repeated request id resumes an unfinished broadcast (per-recipient dedupe key
--          'broadcast:<id>' keeps already delivered people from being notified twice). No stale-claim takeover.
--   P7-06  storage_cleanup_requeue() puts exhausted rows (attempts >= 12) back in the queue and writes the history to
--          storage_cleanup_requeues; storage_cleanup_prune_candidates() lists done rows for a person to review (deletes nothing).
--   P7-07  storage_orphans(): READ-ONLY comparison of storage.objects with the database references (and with the open cleanup queue).
--   P7-11  fin_retainer_drafts_unreviewed(): retainer invoices still in draft (read-only).
--          integrity_report() is recreated with the 17 rows of 035 + 2 new rows (19).
--
-- If 017 is ever re-run: re-apply 028, 033, 035, 036, then THIS file (it re-creates integrity_report() with every row).
--
-- ROLLBACK:  psql -f supabase/maintenance/rollback-037.sql   (restores the 17-row integrity_report(), drops what this file added)
--   Rows written to job_runs and storage_cleanup_requeues are dropped with their tables. No other data is touched.
-- ====================================================================

-- ---------------------------------------------------------------- 1. job ledger (P7-04)
CREATE TABLE IF NOT EXISTS public.job_runs (
    id BIGSERIAL PRIMARY KEY,
    job TEXT NOT NULL CHECK (job <> ''),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    error TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON public.job_runs (job, started_at DESC);
ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_runs FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.job_runs_id_seq FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.job_run_start(p_job TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ INSERT INTO public.job_runs (job) VALUES (p_job) RETURNING id; $$;

-- progress / resume information only; ignored once the run has finished
CREATE OR REPLACE FUNCTION public.job_run_progress(p_id BIGINT, p_checkpoint JSONB)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ UPDATE public.job_runs SET checkpoint = coalesce(p_checkpoint, '{}'::jsonb) WHERE id = p_id AND status = 'running'; $$;

-- finishing is idempotent: the first call wins, a second one changes nothing
CREATE OR REPLACE FUNCTION public.job_run_finish(p_id BIGINT, p_status TEXT, p_error TEXT DEFAULT NULL, p_details JSONB DEFAULT '{}'::jsonb)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('succeeded', 'partial', 'failed') THEN RAISE EXCEPTION 'job_run_finish: invalid status %', p_status; END IF;
  UPDATE public.job_runs SET status = p_status, finished_at = now(), error = left(p_error, 500), details = coalesce(p_details, '{}'::jsonb)
   WHERE id = p_id AND status = 'running';
END $$;

-- one row per job: when it last started, how that run ended, when it last SUCCEEDED, and how many runs are still marked running
CREATE OR REPLACE FUNCTION public.job_status()
RETURNS TABLE (job TEXT, last_started_at TIMESTAMPTZ, last_status TEXT, last_finished_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, running_now BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT j.job,
         l.started_at, l.status, l.finished_at,
         (SELECT max(r.finished_at) FROM public.job_runs r WHERE r.job = j.job AND r.status = 'succeeded'),
         (SELECT count(*) FROM public.job_runs r WHERE r.job = j.job AND r.status = 'running')
  FROM (SELECT DISTINCT job FROM public.job_runs) j
  CROSS JOIN LATERAL (SELECT r.started_at, r.status, r.finished_at FROM public.job_runs r WHERE r.job = j.job ORDER BY r.started_at DESC, r.id DESC LIMIT 1) l
  ORDER BY j.job;
$$;

-- Jobs that have not SUCCEEDED within p_max_age (the caller decides the age; nothing is built in). p_expected lists jobs that must
-- exist even if they never ran (a job missing from the ledger is the most likely "never scheduled").
CREATE OR REPLACE FUNCTION public.job_missed_runs(p_max_age INTERVAL, p_expected TEXT[] DEFAULT ARRAY[]::TEXT[])
RETURNS TABLE (job TEXT, last_success_at TIMESTAMPTZ, last_status TEXT, never_ran BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT k.job, s.last_success_at, s.last_status, (s.job IS NULL) AS never_ran
  FROM (SELECT DISTINCT job FROM public.job_runs UNION SELECT unnest(coalesce(p_expected, ARRAY[]::TEXT[]))) k
  LEFT JOIN public.job_status() s ON s.job = k.job
  WHERE s.last_success_at IS NULL OR s.last_success_at < now() - p_max_age
  ORDER BY k.job;
$$;

-- runs still marked "running" after p_older_than: a crashed or killed worker (it only lists them)
CREATE OR REPLACE FUNCTION public.job_stuck_runs(p_older_than INTERVAL)
RETURNS TABLE (id BIGINT, job TEXT, started_at TIMESTAMPTZ, checkpoint JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT r.id, r.job, r.started_at, r.checkpoint FROM public.job_runs r WHERE r.status = 'running' AND r.started_at < now() - p_older_than ORDER BY r.started_at; $$;

-- ---------------------------------------------------------------- 2. digest candidates (P7-02, P7-03)
-- One row per person with something to be reminded about, in user-id order (keyset paging: pass the last user_id as p_after).
-- first_label: the most urgent item (overdue first, then today, then tomorrow; earlier date first).
CREATE OR REPLACE FUNCTION public.due_digest_batch(p_today DATE, p_tomorrow DATE, p_after UUID DEFAULT NULL, p_limit INTEGER DEFAULT 500)
RETURNS TABLE (user_id UUID, late_count INTEGER, today_count INTEGER, tomorrow_count INTEGER, first_label TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH g AS (
    SELECT t.assigned_to AS u,
           count(*) FILTER (WHERE t.due_date < p_today)::int AS late,
           count(*) FILTER (WHERE t.due_date = p_today)::int AS tod,
           count(*) FILTER (WHERE t.due_date > p_today)::int AS tom,
           (array_agg(t.task_number || ' ' || t.title ORDER BY CASE WHEN t.due_date < p_today THEN 0 WHEN t.due_date = p_today THEN 1 ELSE 2 END, t.due_date, t.task_number))[1] AS first_label
    FROM public.tasks t
    WHERE t.assigned_to IS NOT NULL
      AND t.status NOT IN ('completed', 'approved', 'cancelled', 'backlog')
      AND t.due_date <= p_tomorrow
      AND (p_after IS NULL OR t.assigned_to > p_after)
    GROUP BY t.assigned_to)
  SELECT g.u, g.late, g.tod, g.tom, g.first_label
  FROM g
  JOIN public.profiles p ON p.id = g.u AND p.employment_status = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id = g.u AND n.type = 'due_digest'
                    AND (n.created_at >= now() - interval '20 hours' OR n.dedupe_key = 'due_digest:' || p_today::text))
  ORDER BY g.u
  LIMIT greatest(1, least(coalesce(p_limit, 500), 1000));
$$;

CREATE OR REPLACE FUNCTION public.publish_digest_batch(p_today DATE, p_tomorrow DATE, p_after UUID DEFAULT NULL, p_limit INTEGER DEFAULT 500)
RETURNS TABLE (user_id UUID, late_count INTEGER, today_count INTEGER, tomorrow_count INTEGER, first_label TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH g AS (
    SELECT cp.publisher_id AS u,
           count(*) FILTER (WHERE cp.post_date < p_today)::int AS late,
           count(*) FILTER (WHERE cp.post_date = p_today)::int AS tod,
           count(*) FILTER (WHERE cp.post_date > p_today)::int AS tom,
           (array_agg(cp.title || CASE WHEN pl.title IS NOT NULL THEN ' (' || pl.title || ')' ELSE '' END
                      || CASE WHEN cp.post_time IS NOT NULL THEN ' ' || left(cp.post_time::text, 5) ELSE '' END
                      ORDER BY CASE WHEN cp.post_date = p_today THEN 0 WHEN cp.post_date < p_today THEN 1 ELSE 2 END, cp.post_date, cp.post_time, cp.id))[1] AS first_label
    FROM public.content_posts cp
    LEFT JOIN public.content_plans pl ON pl.id = cp.plan_id
    WHERE cp.publisher_id IS NOT NULL AND cp.status <> 'published' AND cp.post_date IS NOT NULL AND cp.post_date <= p_tomorrow
      AND (p_after IS NULL OR cp.publisher_id > p_after)
    GROUP BY cp.publisher_id)
  SELECT g.u, g.late, g.tod, g.tom, g.first_label
  FROM g
  JOIN public.profiles p ON p.id = g.u AND p.employment_status = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id = g.u AND n.type = 'publish_reminder'
                    AND (n.created_at >= now() - interval '20 hours' OR n.dedupe_key = 'publish_reminder:' || p_today::text))
  ORDER BY g.u
  LIMIT greatest(1, least(coalesce(p_limit, 500), 1000));
$$;

-- ---------------------------------------------------------------- 3. broadcasts (P7-05)
-- state: 'new' (claimed now), 'resume' (same request id, same sender and content, not finished: deliver again, dedupe keys protect),
--        'done' (already finished), 'conflict' (the request id was used for something else). Atomic: the unique index on request_id decides.
CREATE OR REPLACE FUNCTION public.broadcast_claim(p_sender UUID, p_title TEXT, p_message TEXT, p_link TEXT, p_audience_type TEXT, p_label TEXT, p_request UUID)
RETURNS TABLE (broadcast_id UUID, state TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id UUID; b public.broadcasts%ROWTYPE;
BEGIN
  INSERT INTO public.broadcasts (sender_id, title, message, link, audience_type, audience_label, recipient_count, request_id)
  VALUES (p_sender, p_title, p_message, p_link, p_audience_type, left(p_label, 200), 0, p_request)
  ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, 'new'::text; RETURN; END IF;

  SELECT * INTO b FROM public.broadcasts WHERE request_id = p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'broadcast_claim: the claim disappeared'; END IF;
  IF b.sender_id IS DISTINCT FROM p_sender OR b.title <> p_title OR b.message <> p_message
     OR b.link IS DISTINCT FROM p_link OR b.audience_type <> p_audience_type THEN
    RETURN QUERY SELECT b.id, 'conflict'::text;
  ELSIF b.completed_at IS NOT NULL THEN
    RETURN QUERY SELECT b.id, 'done'::text;
  ELSE
    RETURN QUERY SELECT b.id, 'resume'::text;
  END IF;
END $$;

-- counts who was actually notified (the notification rows are the truth) and closes the broadcast; repeatable
CREATE OR REPLACE FUNCTION public.broadcast_finish(p_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM public.notifications WHERE dedupe_key = 'broadcast:' || p_id::text;
  UPDATE public.broadcasts SET recipient_count = v_n, completed_at = coalesce(completed_at, now()) WHERE id = p_id;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------- 4. storage cleanup (P7-06, P7-07)
CREATE TABLE IF NOT EXISTS public.storage_cleanup_requeues (
    id BIGSERIAL PRIMARY KEY,
    queue_id BIGINT NOT NULL,
    bucket TEXT NOT NULL,
    path TEXT NOT NULL,
    requeued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts_before INTEGER NOT NULL,
    last_error_before TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_requeues_queue ON public.storage_cleanup_requeues (queue_id);
ALTER TABLE public.storage_cleanup_requeues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.storage_cleanup_requeues FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.storage_cleanup_requeues_id_seq FROM anon, authenticated;

-- Gives rows that used up their attempts (attempts >= 12, still open) a fresh set of attempts. The old attempt count and error are
-- written to storage_cleanup_requeues first; last_error stays on the queue row. Two callers at once never take the same row.
-- p_ids NULL = every exhausted row. Returns how many were requeued.
CREATE OR REPLACE FUNCTION public.storage_cleanup_requeue(p_ids BIGINT[] DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH c AS (
    SELECT q.id, q.bucket, q.path, q.attempts, q.last_error FROM public.storage_cleanup_queue q
    WHERE q.done_at IS NULL AND q.attempts >= 12 AND (p_ids IS NULL OR q.id = ANY (p_ids))
    ORDER BY q.id FOR UPDATE SKIP LOCKED),
  h AS (
    INSERT INTO public.storage_cleanup_requeues (queue_id, bucket, path, attempts_before, last_error_before)
    SELECT c.id, c.bucket, c.path, c.attempts, c.last_error FROM c RETURNING queue_id),
  u AS (
    UPDATE public.storage_cleanup_queue q SET attempts = 0, next_attempt_at = now() FROM c WHERE q.id = c.id RETURNING q.id)
  SELECT count(*) INTO v_n FROM u;
  RETURN v_n;
END $$;

-- Completed rows (done_at set) older than p_older_than. Report only: nothing is deleted and no period is built in.
CREATE OR REPLACE FUNCTION public.storage_cleanup_prune_candidates(p_older_than INTERVAL, p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (id BIGINT, bucket TEXT, path TEXT, source TEXT, done_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT q.id, q.bucket, q.path, q.source, q.done_at FROM public.storage_cleanup_queue q
  WHERE q.done_at IS NOT NULL AND q.done_at < now() - p_older_than
  ORDER BY q.done_at, q.id LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000));
$$;

-- Storage objects (the three private buckets) that no database row points at and that are not already queued for removal,
-- and that are older than p_older_than (so an upload that is still being attached is never listed). READ-ONLY.
-- References: task_attachments / assets / content_post_assets .storage_path, messages.metadata->>'path'.
CREATE OR REPLACE FUNCTION public.storage_orphans(p_older_than INTERVAL, p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (bucket_id TEXT, name TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT o.bucket_id::text, o.name::text, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id IN ('task-attachments', 'studio-assets', 'chat-media')
    AND o.created_at < now() - p_older_than
    AND NOT EXISTS (SELECT 1 FROM public.storage_cleanup_queue q WHERE q.done_at IS NULL AND q.bucket = o.bucket_id AND q.path = o.name)
    AND CASE o.bucket_id
          WHEN 'task-attachments' THEN NOT EXISTS (SELECT 1 FROM public.task_attachments a WHERE a.storage_path = o.name)
          WHEN 'studio-assets' THEN NOT EXISTS (SELECT 1 FROM public.assets a WHERE a.storage_path = o.name)
                                AND NOT EXISTS (SELECT 1 FROM public.content_post_assets a WHERE a.storage_path = o.name)
          ELSE NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.metadata ->> 'path' = o.name)
        END
  ORDER BY o.created_at, o.name
  LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000));
END $$;

-- ---------------------------------------------------------------- 5. retainer drafts (P7-11)
CREATE OR REPLACE FUNCTION public.fin_retainer_drafts_unreviewed()
RETURNS TABLE (invoice_id UUID, invoice_number TEXT, client_id UUID, period_month DATE, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT i.id, i.invoice_number, i.client_id, i.period_month, i.created_at
  FROM public.invoices i WHERE i.kind = 'retainer' AND i.status = 'draft' ORDER BY i.created_at, i.id;
$$;

-- ---------------------------------------------------------------- 6. privileges: service role only
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'job_run_start(text)', 'job_run_progress(bigint,jsonb)', 'job_run_finish(bigint,text,text,jsonb)', 'job_status()',
    'job_missed_runs(interval,text[])', 'job_stuck_runs(interval)',
    'due_digest_batch(date,date,uuid,integer)', 'publish_digest_batch(date,date,uuid,integer)',
    'broadcast_claim(uuid,text,text,text,text,text,uuid)', 'broadcast_finish(uuid)',
    'storage_cleanup_requeue(bigint[])', 'storage_cleanup_prune_candidates(interval,integer)', 'storage_orphans(interval,integer)',
    'fin_retainer_drafts_unreviewed()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 7. integrity_report(): the 17 rows of 035 (unchanged) + 2 new rows
CREATE OR REPLACE FUNCTION public.integrity_report()
RETURNS TABLE (check_name TEXT, n BIGINT, hint TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT * FROM (VALUES
    ('invoices that disagree with their lines / payments', (SELECT count(*) FROM public.fin_reconcile_invoices()), 'fin_reconcile_invoices()'),
    ('money figures of records that no longer exist', (SELECT count(*) FROM public.money_figure_orphans()), 'money_figure_orphans()'),
    ('people whose profile department differs from their primary department', (SELECT count(*) FROM public.department_link_drift()), 'department_link_drift()'),
    ('Kite Drive accounts created but never linked', (SELECT count(*) FROM public.drive_link_orphans()), 'drive_link_orphans()'),
    ('storage files waiting to be removed', (SELECT count(*) FROM public.storage_cleanup_queue WHERE done_at IS NULL), 'storage_cleanup_status()'),
    ('storage files that failed removal at least once', (SELECT count(*) FROM public.storage_cleanup_queue WHERE done_at IS NULL AND last_error IS NOT NULL), 'storage_cleanup_queue.last_error'),
    ('storage files given up after 12 attempts', (SELECT count(*) FROM public.storage_cleanup_queue WHERE done_at IS NULL AND attempts >= 12), 'needs a person'),
    ('attendance records open for more than 24 hours', (SELECT count(*) FROM public.hr_open_attendance()), 'hr_open_attendance()'),
    ('budgets whose stored spent differs from the derived figure', (SELECT count(*) FROM public.budget_reconciliation()), 'budget_reconciliation()'),
    ('decided expenses without an approval record', (SELECT count(*) FROM public.expenses e WHERE e.status IN ('approved', 'rejected') AND NOT EXISTS (SELECT 1 FROM public.expense_approvals a WHERE a.expense_id = e.id)), 'legacy rows; not invented'),
    ('visuals pointing at a post of another plan', (SELECT count(*) FROM public.content_post_assets a WHERE a.post_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.content_posts p WHERE p.id = a.post_id AND p.plan_id = a.plan_id)), 'content_post_assets_plan_post_fk'),
    ('constraints still NOT VALID in the public schema', (SELECT count(*) FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace), 'clean the data, re-run the migration that added them'),
    ('foreign keys without a supporting index', (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)), 'migration 033 section 4'),
    ('past retainer months without an invoice (active plans)', (SELECT count(*) FROM public.fin_retainer_gaps()), 'fin_retainer_gaps(); report only, nothing is back-filled'),
    ('won leads without a client', (SELECT count(*) FROM public.crm_won_leads_without_client()), 'crm_won_leads_without_client()'),
    ('invoices linked to a project / task / department of another client', (SELECT count(*) FROM public.fin_invoice_link_drift()), 'fin_invoice_link_drift()'),
    ('projects invoiced above their budget figure', (SELECT count(*) FROM public.fin_project_invoicing_vs_budget()), 'fin_project_invoicing_vs_budget(); amounts before VAT'),
    ('background jobs whose most recent run failed', (SELECT count(*) FROM public.job_status() WHERE last_status = 'failed'), 'job_status(); job_missed_runs(age, expected jobs) for jobs that stopped running'),
    ('retainer invoices still in draft', (SELECT count(*) FROM public.fin_retainer_drafts_unreviewed()), 'fin_retainer_drafts_unreviewed(); a person reviews and sends them')
  ) v(check_name, n, hint);
$$;
REVOKE ALL ON FUNCTION public.integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integrity_report() TO service_role;
