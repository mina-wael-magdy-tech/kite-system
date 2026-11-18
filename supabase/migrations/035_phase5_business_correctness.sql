-- ====================================================================
-- KITE SYSTEM — 035_phase5_business_correctness.sql   (Phase 5: business logic and financial correctness)
--
-- Additive and idempotent. It changes no existing business rule, workflow or stored figure.
--
--   P5-01  fin_kpis(), fin_client_balances()   Finance KPIs and per-client open balances computed in the database, per
--                                              currency, on the STUDIO business month. They replace browser-side sums that
--                                              used the UTC month and were cut at PostgREST's 1000-row limit.
--                                              SECURITY INVOKER: row-level security applies; the function ALSO refuses
--                                              anyone who is not an executive (auth_is_finance()). anon / PUBLIC: no EXECUTE.
--   P5-02  fin_invoice_links_guard             A trigger on invoices: when the client, project, task or department of an
--                                              invoice is set or changed, the links must belong to the same client.
--                                              Unverifiable links (project without a client, task without a project, a
--                                              client without departments) are allowed. Retainer invoices are exempt from the
--                                              department rule (the department comes from the retainer plan). Rows that do
--                                              not touch these four columns are never checked, so legacy data cannot block
--                                              payments, status refreshes or voiding. fin_invoice_link_drift() lists legacy rows.
--   P5-04  lead_stage_history                  Append-only history of lead creation, stage changes and deletion. No stage
--                                              rule is added or changed. Written by a trigger (nobody can insert, update or
--                                              delete through the API); UPDATE / DELETE / TRUNCATE are refused for everyone.
--   P5-05  fin_retainer_gaps()                 READ-ONLY: active retainer plans with a past month that has no non-void invoice.
--   P5-06  crm_won_leads_without_client(), fin_project_invoicing_vs_budget(), fin_invoice_link_drift()
--                                              READ-ONLY detectors; integrity_report() lists them (17 rows now).
--
-- If 017 is ever re-run: re-apply 028, then 033, then THIS file (it re-creates integrity_report() with the 033 rows plus these).
--
-- ROLLBACK (no business data is touched):
--   DROP TRIGGER IF EXISTS fin_invoice_links_guard ON public.invoices;
--   DROP TRIGGER IF EXISTS lead_stage_history_ins ON public.leads;  DROP TRIGGER IF EXISTS lead_stage_history_upd ON public.leads;
--   DROP TRIGGER IF EXISTS lead_stage_history_del ON public.leads;
--   DROP FUNCTION IF EXISTS public.fin_invoice_links_guard(), public.lead_stage_history_write(), public.lead_stage_history_immutable(),
--     public.fin_kpis(), public.fin_client_balances(), public.fin_retainer_gaps(), public.crm_won_leads_without_client(),
--     public.fin_project_invoicing_vs_budget(), public.fin_invoice_link_drift();
--   Then restore the 13-row integrity_report() by re-running 033 (section 5).
--   DROP TABLE public.lead_stage_history;      -- only if the history may be discarded (it is the audit trail)
-- ====================================================================

-- ---------------------------------------------------------------- 1. P5-01 KPIs in the database (studio month, per currency)
CREATE OR REPLACE FUNCTION public.fin_kpis()
RETURNS TABLE (metric TEXT, currency TEXT, amount NUMERIC)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_today DATE := public.studio_today();
  v_from DATE := public.studio_today() - (extract(day FROM public.studio_today())::int - 1);   -- first day of the studio month
  v_to DATE := (public.studio_today() - (extract(day FROM public.studio_today())::int - 1) + interval '1 month')::date;
BEGIN
  IF NOT public.auth_is_finance() THEN
    RAISE EXCEPTION 'Finance access is limited to the owner, CEO and super administrator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT 'outstanding'::text, i.currency, coalesce(sum(i.balance), 0)::numeric
      FROM public.invoices i WHERE i.status IN ('sent', 'partially_paid', 'overdue') GROUP BY i.currency
    UNION ALL
    SELECT 'overdue'::text, i.currency, coalesce(sum(i.balance), 0)::numeric
      FROM public.invoices i WHERE i.status = 'overdue' GROUP BY i.currency
    UNION ALL
    SELECT 'collected'::text, i.currency, coalesce(sum(p.amount), 0)::numeric
      FROM public.invoice_payments p JOIN public.invoices i ON i.id = p.invoice_id
      WHERE p.reversed_at IS NULL AND p.paid_on >= v_from AND p.paid_on < v_to GROUP BY i.currency;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_kpis() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fin_client_balances()
RETURNS TABLE (client_id UUID, currency TEXT, balance NUMERIC)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF NOT public.auth_is_finance() THEN
    RAISE EXCEPTION 'Finance access is limited to the owner, CEO and super administrator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.client_id, i.currency, sum(i.balance)::numeric
      FROM public.invoices i
      WHERE i.client_id IS NOT NULL AND i.status IN ('sent', 'partially_paid', 'overdue')
      GROUP BY i.client_id, i.currency HAVING sum(i.balance) > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_client_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_client_balances() TO authenticated, service_role;

-- ---------------------------------------------------------------- 2. P5-02 invoice links belong to the invoice's client
CREATE OR REPLACE FUNCTION public.fin_invoice_links_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_pc UUID; v_tp UUID;
BEGIN
  IF public.fin_migrating() THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
     AND NEW.task_id IS NOT DISTINCT FROM OLD.task_id AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id THEN
    RETURN NEW;                                   -- nothing about the links changed: never block payments, status refreshes, voiding
  END IF;
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;      -- nothing to compare against
  IF NEW.project_id IS NOT NULL THEN
    SELECT p.client_id INTO v_pc FROM public.projects p WHERE p.id = NEW.project_id;
    IF v_pc IS NOT NULL AND v_pc <> NEW.client_id THEN
      RAISE EXCEPTION 'The project belongs to a different client than this invoice';
    END IF;
  END IF;
  IF NEW.task_id IS NOT NULL THEN
    SELECT t.project_id INTO v_tp FROM public.tasks t WHERE t.id = NEW.task_id;
    IF v_tp IS NOT NULL THEN
      IF NEW.project_id IS NOT NULL AND v_tp <> NEW.project_id THEN
        RAISE EXCEPTION 'The task belongs to a different project than this invoice';
      END IF;
      SELECT p.client_id INTO v_pc FROM public.projects p WHERE p.id = v_tp;
      IF v_pc IS NOT NULL AND v_pc <> NEW.client_id THEN
        RAISE EXCEPTION 'The task belongs to a project of a different client than this invoice';
      END IF;
    END IF;
  END IF;
  IF NEW.department_id IS NOT NULL AND NEW.kind IS DISTINCT FROM 'retainer'
     AND EXISTS (SELECT 1 FROM public.client_departments cd WHERE cd.client_id = NEW.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.client_departments cd WHERE cd.client_id = NEW.client_id AND cd.department_id = NEW.department_id) THEN
    RAISE EXCEPTION 'The department does not serve this invoice''s client';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_invoice_links_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS fin_invoice_links_guard ON public.invoices;
CREATE TRIGGER fin_invoice_links_guard BEFORE INSERT OR UPDATE OF client_id, project_id, task_id, department_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.fin_invoice_links_guard();

-- legacy rows that already break the rule (read-only; the trigger only looks at rows whose links change)
CREATE OR REPLACE FUNCTION public.fin_invoice_link_drift()
RETURNS TABLE (invoice_id UUID, invoice_number TEXT, problem TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT i.id, i.invoice_number, 'project belongs to another client'
    FROM public.invoices i JOIN public.projects p ON p.id = i.project_id
    WHERE i.client_id IS NOT NULL AND p.client_id IS NOT NULL AND p.client_id <> i.client_id
  UNION ALL
  SELECT i.id, i.invoice_number, 'task belongs to another project'
    FROM public.invoices i JOIN public.tasks t ON t.id = i.task_id
    WHERE i.project_id IS NOT NULL AND t.project_id IS NOT NULL AND t.project_id <> i.project_id
  UNION ALL
  SELECT i.id, i.invoice_number, 'task belongs to a project of another client'
    FROM public.invoices i JOIN public.tasks t ON t.id = i.task_id JOIN public.projects p ON p.id = t.project_id
    WHERE i.client_id IS NOT NULL AND p.client_id IS NOT NULL AND p.client_id <> i.client_id
  UNION ALL
  SELECT i.id, i.invoice_number, 'department does not serve the client'
    FROM public.invoices i
    WHERE i.client_id IS NOT NULL AND i.department_id IS NOT NULL AND i.kind IS DISTINCT FROM 'retainer'
      AND EXISTS (SELECT 1 FROM public.client_departments cd WHERE cd.client_id = i.client_id)
      AND NOT EXISTS (SELECT 1 FROM public.client_departments cd WHERE cd.client_id = i.client_id AND cd.department_id = i.department_id);
$$;
REVOKE ALL ON FUNCTION public.fin_invoice_link_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_invoice_link_drift() TO service_role;

-- ---------------------------------------------------------------- 3. P5-04 append-only lead stage history
CREATE TABLE IF NOT EXISTS public.lead_stage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL,                  -- no foreign key on purpose: the history outlives a deleted lead
    lead_title TEXT,
    client_id UUID,
    event TEXT NOT NULL CHECK (event IN ('created', 'stage_changed', 'deleted')),
    from_stage TEXT,
    to_stage TEXT,
    actor_id UUID,                          -- auth.uid() when a signed-in person did it, NULL for the service role / the database operator
    actor_label TEXT,                       -- the person's name at that moment (survives a deleted profile)
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead ON public.lead_stage_history (lead_id, changed_at);

ALTER TABLE public.lead_stage_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_stage_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_stage_history TO authenticated;
GRANT ALL ON public.lead_stage_history TO service_role;
DROP POLICY IF EXISTS lead_stage_history_select ON public.lead_stage_history;
-- who can read a lead's history = who can read the lead (the sub-select runs under the caller's own RLS); admins also see deleted leads
CREATE POLICY lead_stage_history_select ON public.lead_stage_history FOR SELECT TO authenticated
  USING (public.auth_is_admin() OR EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_stage_history.lead_id));

CREATE OR REPLACE FUNCTION public.lead_stage_history_write()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_actor UUID := auth.uid(); v_label TEXT;
BEGIN
  IF v_actor IS NOT NULL THEN SELECT p.full_name INTO v_label FROM public.profiles p WHERE p.id = v_actor; END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lead_stage_history (lead_id, lead_title, client_id, event, from_stage, to_stage, actor_id, actor_label)
    VALUES (NEW.id, NEW.title, NEW.client_id, 'created', NULL, NEW.stage, v_actor, v_label);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.lead_stage_history (lead_id, lead_title, client_id, event, from_stage, to_stage, actor_id, actor_label)
    VALUES (NEW.id, NEW.title, NEW.client_id, 'stage_changed', OLD.stage, NEW.stage, v_actor, v_label);
    RETURN NEW;
  ELSE
    INSERT INTO public.lead_stage_history (lead_id, lead_title, client_id, event, from_stage, to_stage, actor_id, actor_label)
    VALUES (OLD.id, OLD.title, OLD.client_id, 'deleted', OLD.stage, NULL, v_actor, v_label);
    RETURN OLD;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.lead_stage_history_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS lead_stage_history_ins ON public.leads;
CREATE TRIGGER lead_stage_history_ins AFTER INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public.lead_stage_history_write();
DROP TRIGGER IF EXISTS lead_stage_history_upd ON public.leads;
CREATE TRIGGER lead_stage_history_upd AFTER UPDATE OF stage ON public.leads FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION public.lead_stage_history_write();
DROP TRIGGER IF EXISTS lead_stage_history_del ON public.leads;
CREATE TRIGGER lead_stage_history_del AFTER DELETE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.lead_stage_history_write();

CREATE OR REPLACE FUNCTION public.lead_stage_history_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'lead_stage_history is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.lead_stage_history_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS lead_stage_history_append_only ON public.lead_stage_history;
CREATE TRIGGER lead_stage_history_append_only BEFORE UPDATE OR DELETE ON public.lead_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.lead_stage_history_immutable();
DROP TRIGGER IF EXISTS lead_stage_history_no_truncate ON public.lead_stage_history;
CREATE TRIGGER lead_stage_history_no_truncate BEFORE TRUNCATE ON public.lead_stage_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.lead_stage_history_immutable();

-- ---------------------------------------------------------------- 4. P5-05 / P5-06 read-only detectors
-- Active retainer plans: every month from the later of (the plan's start month, the month the plan was created) up to the
-- month BEFORE the current studio month (and not past the plan's end month) that has no non-void invoice. Reports only.
CREATE OR REPLACE FUNCTION public.fin_retainer_gaps()
RETURNS TABLE (plan_id UUID, client_id UUID, plan_name TEXT, month DATE)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pl.id, pl.client_id, pl.name, g.m::date
  FROM public.retainer_plans pl
  CROSS JOIN LATERAL generate_series(
      (greatest(pl.start_date, public.studio_date(pl.created_at)) - (extract(day FROM greatest(pl.start_date, public.studio_date(pl.created_at)))::int - 1))::timestamp,
      (least(
         (public.studio_today() - (extract(day FROM public.studio_today())::int - 1) - interval '1 month')::date,
         coalesce(pl.end_date, '9999-12-31'::date) - (extract(day FROM coalesce(pl.end_date, '9999-12-31'::date))::int - 1)
       ))::timestamp,
      interval '1 month') AS g(m)
  WHERE pl.is_active
    AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.retainer_plan_id = pl.id AND i.period_month = g.m::date AND i.status <> 'void')
  ORDER BY pl.id, g.m;
$$;
REVOKE ALL ON FUNCTION public.fin_retainer_gaps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_retainer_gaps() TO service_role;

CREATE OR REPLACE FUNCTION public.crm_won_leads_without_client()
RETURNS TABLE (lead_id UUID, title TEXT, updated_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT l.id, l.title, l.updated_at FROM public.leads l WHERE l.stage = 'won' AND l.client_id IS NULL ORDER BY l.updated_at; $$;
REVOKE ALL ON FUNCTION public.crm_won_leads_without_client() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_won_leads_without_client() TO service_role;

-- Issued, non-void invoices of a project (amounts before VAT, in the finance currency) against the project's budget figure (money_figures).
CREATE OR REPLACE FUNCTION public.fin_project_invoicing_vs_budget()
RETURNS TABLE (project_id UUID, code TEXT, name TEXT, budget NUMERIC, invoiced NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id, p.code, p.name, m.amount, sum(i.subtotal)
  FROM public.projects p
  JOIN public.money_figures m ON m.entity = 'project_budget' AND m.entity_id = p.id
  JOIN public.invoices i ON i.project_id = p.id AND i.status NOT IN ('draft', 'void')
       AND i.currency = coalesce((SELECT s.currency FROM public.finance_settings s WHERE s.id), 'EGP')
  GROUP BY p.id, p.code, p.name, m.amount
  HAVING sum(i.subtotal) > m.amount
  ORDER BY p.code;
$$;
REVOKE ALL ON FUNCTION public.fin_project_invoicing_vs_budget() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_project_invoicing_vs_budget() TO service_role;

-- ---------------------------------------------------------------- 5. integrity_report(): the 13 rows of 033 + the 4 new detectors
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
