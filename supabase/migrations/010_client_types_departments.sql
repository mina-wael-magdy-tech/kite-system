-- ====================================================================
-- KITE SYSTEM — 010_client_types_departments.sql
--   * Clients are either "retainer" (regular, fixed monthly budget) or "project" (irregular, per job).
--   * Monthly budget is stored in EGP.
--   * A client can be served by one or more departments (classification).
-- Safe to run more than once.
-- ====================================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'EGP';

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_client_type_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_client_type_check CHECK (client_type IN ('retainer', 'project'));
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_monthly_budget_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_monthly_budget_check CHECK (monthly_budget IS NULL OR monthly_budget >= 0);

CREATE TABLE IF NOT EXISTS public.client_departments (
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (client_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_client_departments_dept ON public.client_departments(department_id);

ALTER TABLE public.client_departments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.client_departments TO authenticated;

-- same rules as the clients table: staff read, managers change
DROP POLICY IF EXISTS "client_departments_select" ON public.client_departments;
CREATE POLICY "client_departments_select" ON public.client_departments FOR SELECT TO authenticated
    USING (public.auth_is_staff());
DROP POLICY IF EXISTS "client_departments_insert" ON public.client_departments;
CREATE POLICY "client_departments_insert" ON public.client_departments FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());
DROP POLICY IF EXISTS "client_departments_delete" ON public.client_departments;
CREATE POLICY "client_departments_delete" ON public.client_departments FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'client_departments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.client_departments;
  END IF;
END $$;
