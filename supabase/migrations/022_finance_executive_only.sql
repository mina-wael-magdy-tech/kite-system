-- ====================================================================
-- 022  Finance data is EXECUTIVE-ONLY (super_admin, owner, ceo)   (ARC-01 policy)
--
-- Approved policy: only super_admin, owner and ceo may VIEW Finance data. finance_manager and accountant
-- (and general_manager, HR, managers, employees, clients) must not read it, and belonging to the Finance
-- department grants nothing.
--
-- Migration 015 made money owner-only; migration 017 then widened it to the "finance tier"
-- (auth_is_finance() = executives + finance_manager + accountant) on 13 tables and added a policy that
-- lets that tier read EVERY client. This migration restores the strict boundary:
--
--   1. auth_is_finance() now means exactly "executive". Every policy that calls it (finance_settings,
--      client_billing, retainer_plans, invoice_items, invoice_payments, invoice_number_seq,
--      finance_audit_log, invoices, expenses, budgets, vendors) becomes executive-only without being rewritten.
--   2. expenses: the extra "a person may read the claims they filed" rule is removed (expense records are
--      Finance data). Staff keep the INSERT policy, so a claim can still be filed through the API.
--   3. expense_approvals: executive-only (was admins + finance_manager + the submitter).
--   4. clients_select_finance (017) is dropped: finance roles go back to the normal department-scoped
--      client visibility instead of seeing every client.
--   5. audit_logs: finance events (EXPENSE_* actions and finance entity types) are visible to executives only;
--      general_manager keeps every other audit event.
--
-- Not touched: money_figures, budgets/vendors/invoices write policies (already owner-only), fin_* functions
-- (service_role only), table grants, data. No data is changed or deleted.
-- Apply AFTER 015, 017 and 021, as a single script on its own (do NOT use `supabase db push` on live).
-- Safe to run more than once.
--
-- Rollback: re-create the previous definitions from 017 (auth_is_finance with finance_manager/accountant,
-- clients_select_finance) and 002/015 (expenses_select, expense_approvals_select, audit_logs_select).
-- ====================================================================

-- 1. the predicate: executive only (CREATE OR REPLACE keeps the existing EXECUTE grants)
CREATE OR REPLACE FUNCTION public.auth_is_finance()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('super_admin', 'owner', 'ceo')
      AND r.is_active = true
  );
$$;
REVOKE ALL ON FUNCTION public.auth_is_finance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_is_finance() TO authenticated, service_role;

-- 2. expense claims: executives only (staff can still INSERT their own claim)
DROP POLICY IF EXISTS "expenses_select" ON public.expenses;
CREATE POLICY "expenses_select" ON public.expenses FOR SELECT TO authenticated
  USING (public.auth_is_finance());

-- 3. expense approvals: executives only
DROP POLICY IF EXISTS "expense_approvals_select" ON public.expense_approvals;
CREATE POLICY "expense_approvals_select" ON public.expense_approvals FOR SELECT TO authenticated
  USING (public.auth_is_finance());

-- 4. finance roles no longer see every client
DROP POLICY IF EXISTS "clients_select_finance" ON public.clients;

-- 5. finance events in the audit log: executives only
DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
CREATE POLICY "audit_logs_select" ON public.audit_logs FOR SELECT TO authenticated
  USING (
    CASE WHEN action LIKE 'EXPENSE\_%'
           OR entity_type IN ('expenses', 'expense_approvals', 'invoices', 'invoice_items', 'invoice_payments',
                              'budgets', 'vendors', 'retainer_plans', 'client_billing', 'finance_settings', 'money_figures')
         THEN public.auth_is_finance()          -- finance events: executives only
         ELSE public.auth_is_admin()            -- every other event: unchanged
    END
  );
