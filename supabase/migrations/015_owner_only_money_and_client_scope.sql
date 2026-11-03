-- ====================================================================
-- KITE SYSTEM — 015_owner_only_money_and_client_scope.sql
--
--   1. Money is visible ONLY to the owner / CEO (roles: owner, ceo, super_admin).
--        - Finance tables (budgets, vendors, invoices, expenses, ...) become owner-only.
--        - Every budget / deal value moves into `money_figures` (owner-only). The old columns are
--          emptied and forced to stay empty by a trigger, so nobody else can read or plant numbers.
--   2. Clients are scoped by department: everyone below the owner / CEO sees only the clients that
--      belong to a department they are in (plus clients they created or manage).
--
--   Safe to run more than once. Run AFTER 001-014.
-- ====================================================================

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public.auth_is_owner()
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

-- is the signed-in person a member of this department (main department or extra membership)?
CREATE OR REPLACE FUNCTION public.auth_in_dept(p_dept_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_dept_id IS NOT NULL AND public.auth_is_active() AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.department_id = p_dept_id)
    OR EXISTS (SELECT 1 FROM public.user_departments ud WHERE ud.user_id = auth.uid() AND ud.department_id = p_dept_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_can_see_client(p_client_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND (
    public.auth_is_owner()
    OR EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = p_client_id AND (c.account_manager_id = auth.uid() OR c.created_by = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.client_departments cd
      WHERE cd.client_id = p_client_id AND public.auth_in_dept(cd.department_id)
    )
  );
$$;

-- ---------------------------------------------------------------- client scope
DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select" ON public.clients FOR SELECT TO authenticated
  USING (public.auth_can_see_client(id));

DROP POLICY IF EXISTS "client_departments_select" ON public.client_departments;
CREATE POLICY "client_departments_select" ON public.client_departments FOR SELECT TO authenticated
  USING (public.auth_can_see_client(client_id));

DROP POLICY IF EXISTS "client_contacts_select" ON public.client_contacts;
CREATE POLICY "client_contacts_select" ON public.client_contacts FOR SELECT TO authenticated
  USING (public.auth_is_manager() AND public.auth_can_see_client(client_id));

DROP POLICY IF EXISTS "clients_update" ON public.clients;
CREATE POLICY "clients_update" ON public.clients FOR UPDATE TO authenticated
  USING (public.auth_is_manager() AND public.auth_can_see_client(id))
  WITH CHECK (public.auth_is_manager());

-- ---------------------------------------------------------------- finance tables: owner only
DROP POLICY IF EXISTS "budgets_select" ON public.budgets;
CREATE POLICY "budgets_select" ON public.budgets FOR SELECT TO authenticated USING (public.auth_is_owner());
DROP POLICY IF EXISTS "budgets_insert" ON public.budgets;
CREATE POLICY "budgets_insert" ON public.budgets FOR INSERT TO authenticated WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "budgets_update" ON public.budgets;
CREATE POLICY "budgets_update" ON public.budgets FOR UPDATE TO authenticated USING (public.auth_is_owner()) WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "budgets_delete" ON public.budgets;
CREATE POLICY "budgets_delete" ON public.budgets FOR DELETE TO authenticated USING (public.auth_is_owner());

DROP POLICY IF EXISTS "vendors_select" ON public.vendors;
CREATE POLICY "vendors_select" ON public.vendors FOR SELECT TO authenticated USING (public.auth_is_owner());
DROP POLICY IF EXISTS "vendors_insert" ON public.vendors;
CREATE POLICY "vendors_insert" ON public.vendors FOR INSERT TO authenticated WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "vendors_update" ON public.vendors;
CREATE POLICY "vendors_update" ON public.vendors FOR UPDATE TO authenticated USING (public.auth_is_owner()) WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "vendors_delete" ON public.vendors;
CREATE POLICY "vendors_delete" ON public.vendors FOR DELETE TO authenticated USING (public.auth_is_owner());

DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated USING (public.auth_is_owner());
DROP POLICY IF EXISTS "invoices_insert" ON public.invoices;
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT TO authenticated WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "invoices_update" ON public.invoices;
CREATE POLICY "invoices_update" ON public.invoices FOR UPDATE TO authenticated USING (public.auth_is_owner()) WITH CHECK (public.auth_is_owner());
DROP POLICY IF EXISTS "invoices_delete" ON public.invoices;
CREATE POLICY "invoices_delete" ON public.invoices FOR DELETE TO authenticated USING (public.auth_is_owner());

-- expenses: only the owner reads them (a person may still see rows they filed themselves)
DROP POLICY IF EXISTS "expenses_select" ON public.expenses;
CREATE POLICY "expenses_select" ON public.expenses FOR SELECT TO authenticated
  USING (public.auth_is_owner() OR (public.auth_is_staff() AND submitted_by = auth.uid()));

-- ---------------------------------------------------------------- money_figures (owner only)
CREATE TABLE IF NOT EXISTS public.money_figures (
    entity TEXT NOT NULL CHECK (entity IN ('client_monthly', 'project_budget', 'campaign_budget', 'department_budget', 'lead_value', 'opportunity_value')),
    entity_id UUID NOT NULL,
    amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
    updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity, entity_id)
);

ALTER TABLE public.money_figures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_figures FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_figures TO authenticated;

DROP POLICY IF EXISTS "money_figures_all" ON public.money_figures;
CREATE POLICY "money_figures_all" ON public.money_figures FOR ALL TO authenticated
  USING (public.auth_is_owner()) WITH CHECK (public.auth_is_owner() AND updated_by IS NOT DISTINCT FROM auth.uid());

-- move the existing figures (only rows that actually have a value)
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'client_monthly', id, monthly_budget FROM public.clients WHERE monthly_budget IS NOT NULL AND monthly_budget > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'project_budget', id, budget FROM public.projects WHERE budget IS NOT NULL AND budget > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'campaign_budget', id, budget FROM public.campaigns WHERE budget IS NOT NULL AND budget > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'department_budget', id, budget FROM public.departments WHERE budget IS NOT NULL AND budget > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'lead_value', id, value FROM public.leads WHERE value IS NOT NULL AND value > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.money_figures (entity, entity_id, amount)
  SELECT 'opportunity_value', id, value FROM public.opportunities WHERE value IS NOT NULL AND value > 0
ON CONFLICT DO NOTHING;

-- empty the old columns and keep them empty (anyone can read these tables, so no number may stay there)
CREATE OR REPLACE FUNCTION public.blank_money_columns()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'clients' THEN NEW.monthly_budget := NULL;
  ELSIF TG_TABLE_NAME IN ('projects', 'campaigns', 'departments') THEN NEW.budget := 0;
  ELSE NEW.value := 0;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients', 'projects', 'campaigns', 'departments', 'leads', 'opportunities'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS blank_money ON public.%I', t);
    EXECUTE format('CREATE TRIGGER blank_money BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.blank_money_columns()', t);
  END LOOP;
END $$;

UPDATE public.clients SET monthly_budget = NULL WHERE monthly_budget IS NOT NULL;
UPDATE public.projects SET budget = 0 WHERE budget IS DISTINCT FROM 0;
UPDATE public.campaigns SET budget = 0 WHERE budget IS DISTINCT FROM 0;
UPDATE public.departments SET budget = 0 WHERE budget IS DISTINCT FROM 0;
UPDATE public.leads SET value = 0 WHERE value IS DISTINCT FROM 0;
UPDATE public.opportunities SET value = 0 WHERE value IS DISTINCT FROM 0;
