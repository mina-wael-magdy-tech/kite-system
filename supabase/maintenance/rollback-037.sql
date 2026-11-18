-- Rollback of migration 037 (Phase 7). Restores the 17-row integrity_report() of 035, then drops what 037 added.
-- Rows in job_runs and storage_cleanup_requeues are dropped with their tables; no other data is touched.
BEGIN;
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
    ('projects invoiced above their budget figure', (SELECT count(*) FROM public.fin_project_invoicing_vs_budget()), 'fin_project_invoicing_vs_budget(); amounts before VAT')
  ) v(check_name, n, hint);
$$;
REVOKE ALL ON FUNCTION public.integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integrity_report() TO service_role;
DROP FUNCTION IF EXISTS public.job_run_start(text), public.job_run_progress(bigint,jsonb), public.job_run_finish(bigint,text,text,jsonb),
  public.job_status(), public.job_missed_runs(interval,text[]), public.job_stuck_runs(interval),
  public.due_digest_batch(date,date,uuid,integer), public.publish_digest_batch(date,date,uuid,integer),
  public.broadcast_claim(uuid,text,text,text,text,text,uuid), public.broadcast_finish(uuid),
  public.storage_cleanup_requeue(bigint[]), public.storage_cleanup_prune_candidates(interval,integer), public.storage_orphans(interval,integer),
  public.fin_retainer_drafts_unreviewed();
DROP TABLE IF EXISTS public.job_runs, public.storage_cleanup_requeues;
COMMIT;
