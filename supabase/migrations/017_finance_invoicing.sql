-- ====================================================================
-- KITE SYSTEM — 017_finance_invoicing.sql   (Finance, step 2: clients & invoicing)
--
--   * BACKUP of the old finance tables first (schema finance_backup, nobody can read it through the API).
--   * Finance access tier: owner / CEO / super_admin / finance_manager / accountant  -> auth_is_finance()
--     (payroll, added later, stays owner-only).
--   * client_billing, retainer_plans, finance_settings, invoice_items, invoice_payments,
--     invoice_number_seq, finance_audit_log.
--   * invoices is extended IN PLACE: old rows are kept (one line item + one payment are generated for them).
--   * ALL money math happens here, in NUMERIC, inside SQL functions. The browser never sends totals.
--     Rounding: half away from zero (half-up) to 2 decimals per line, then summed.
--   * Nothing is ever deleted: invoices are voided, payments are reversed, the audit log is append-only.
--   * Writes only through fin_* functions (EXECUTE for service_role only; the finance edge function calls them).
--
--   Safe to run more than once. Run AFTER 001-016.
-- ====================================================================

-- ---------------------------------------------------------------- 0. role + access predicate
INSERT INTO public.roles (name, display_name, description, is_system, priority)
VALUES ('accountant', 'Accountant', 'Invoices, expenses, taxes and reports (no payroll)', true, 4)
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.auth_is_finance()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('super_admin', 'owner', 'ceo', 'finance_manager', 'accountant')
      AND r.is_active = true
  );
$$;
REVOKE ALL ON FUNCTION public.auth_is_finance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_is_finance() TO authenticated, service_role;

-- ---------------------------------------------------------------- 1. backup of the old data
CREATE SCHEMA IF NOT EXISTS finance_backup;
REVOKE ALL ON SCHEMA finance_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS finance_backup.invoices_pre017 AS SELECT * FROM public.invoices;
CREATE TABLE IF NOT EXISTS finance_backup.expenses_pre017 AS SELECT * FROM public.expenses;
CREATE TABLE IF NOT EXISTS finance_backup.expense_approvals_pre017 AS SELECT * FROM public.expense_approvals;
CREATE TABLE IF NOT EXISTS finance_backup.budgets_pre017 AS SELECT * FROM public.budgets;
CREATE TABLE IF NOT EXISTS finance_backup.vendors_pre017 AS SELECT * FROM public.vendors;
DO $$ BEGIN
  IF to_regclass('public.money_figures') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS finance_backup.money_figures_pre017 AS SELECT * FROM public.money_figures';
  END IF;
END $$;

-- ---------------------------------------------------------------- 2. settings (one row)
CREATE TABLE IF NOT EXISTS public.finance_settings (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    currency TEXT NOT NULL DEFAULT 'EGP',
    vat_rate NUMERIC(5, 2) NOT NULL DEFAULT 14.00 CHECK (vat_rate BETWEEN 0 AND 100),
    default_withholding_rate NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (default_withholding_rate BETWEEN 0 AND 100),
    default_payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (default_payment_terms_days BETWEEN 0 AND 365),
    invoice_prefix TEXT NOT NULL DEFAULT 'KITE' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,8}$'),
    company_name_en TEXT NOT NULL DEFAULT 'Kite Design Studio',
    company_name_ar TEXT NOT NULL DEFAULT 'استوديو كايت للتصميم',
    address_en TEXT,
    address_ar TEXT,
    phone TEXT,
    email TEXT,
    tax_registration_no TEXT,          -- seller tax registration number (needed by ETA later)
    commercial_register_no TEXT,
    bank_details TEXT,                 -- printed on invoices (bank, IBAN)
    eta_branch_code TEXT DEFAULT '0',  -- ETA e-invoice: branch + activity code, unused until the integration
    eta_activity_code TEXT,
    updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.finance_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- 3. client billing profile (finance-only)
CREATE TABLE IF NOT EXISTS public.client_billing (
    client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
    billing_type TEXT NOT NULL DEFAULT 'on_demand' CHECK (billing_type IN ('retainer', 'on_demand')),
    legal_name_ar TEXT,
    legal_name_en TEXT,
    tax_registration_no TEXT,
    billing_address TEXT,
    billing_email TEXT,
    withholding_rate NUMERIC(5, 2) CHECK (withholding_rate BETWEEN 0 AND 100),   -- NULL = use the default from finance_settings
    payment_terms_days INTEGER CHECK (payment_terms_days BETWEEN 0 AND 365),     -- NULL = default
    invoice_language TEXT NOT NULL DEFAULT 'both' CHECK (invoice_language IN ('ar', 'en', 'both')),
    eta_receiver_type TEXT NOT NULL DEFAULT 'B' CHECK (eta_receiver_type IN ('B', 'P', 'F')),  -- business / person / foreign
    updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- 4. retainer plans
CREATE TABLE IF NOT EXISTS public.retainer_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
    description_ar TEXT,
    description_en TEXT,
    monthly_fee NUMERIC(15, 2) NOT NULL CHECK (monthly_fee > 0),
    start_date DATE NOT NULL,
    end_date DATE,
    billing_day INTEGER NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_retainer_plans_client ON public.retainer_plans(client_id);

-- ---------------------------------------------------------------- 5. invoices: extend in place
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
UPDATE public.invoices SET status = 'void' WHERE status = 'cancelled';

ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'adhoc',
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,           -- the deliverable
    ADD COLUMN IF NOT EXISTS retainer_plan_id UUID REFERENCES public.retainer_plans(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS period_month DATE,
    ADD COLUMN IF NOT EXISTS issue_date DATE,
    ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'EGP',
    ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'both',
    ADD COLUMN IF NOT EXISTS subtotal NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_total NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS vat_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS withholding_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS withholding_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_receivable NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS issued_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- ETA (Egyptian e-invoice): filled by the future integration
    ADD COLUMN IF NOT EXISTS eta_uuid TEXT,
    ADD COLUMN IF NOT EXISTS eta_status TEXT,
    ADD COLUMN IF NOT EXISTS eta_submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS eta_payload JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check
      CHECK (status IN ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_kind_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('retainer', 'project', 'adhoc', 'payable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_language_check') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_language_check CHECK (language IN ('ar', 'en', 'both'));
  END IF;
END $$;

-- one retainer invoice per plan per month (a voided one may be regenerated)
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_retainer_month
  ON public.invoices (retainer_plan_id, period_month) WHERE retainer_plan_id IS NOT NULL AND status <> 'void';
CREATE INDEX IF NOT EXISTS idx_invoices_client ON public.invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status, due_date);

-- ---------------------------------------------------------------- 6. line items
CREATE TABLE IF NOT EXISTS public.invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 1,
    description_ar TEXT,
    description_en TEXT,
    quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(15, 2) NOT NULL CHECK (unit_price >= 0),
    discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
    vat_rate NUMERIC(5, 2) NOT NULL DEFAULT 14 CHECK (vat_rate BETWEEN 0 AND 100),
    item_code TEXT,                                       -- ETA item code (GS1 / EGS), unused for now
    unit_type TEXT NOT NULL DEFAULT 'EA',                 -- ETA unit type
    line_gross NUMERIC(15, 2) NOT NULL DEFAULT 0,         -- computed by trigger, never trusted from the client
    line_discount NUMERIC(15, 2) NOT NULL DEFAULT 0,
    line_net NUMERIC(15, 2) NOT NULL DEFAULT 0,
    line_vat NUMERIC(15, 2) NOT NULL DEFAULT 0,
    line_total NUMERIC(15, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (coalesce(description_ar, '') <> '' OR coalesce(description_en, '') <> '')
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON public.invoice_items(invoice_id, position);

-- ---------------------------------------------------------------- 7. payments (append-only: reverse, never edit)
CREATE TABLE IF NOT EXISTS public.invoice_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
    paid_on DATE NOT NULL,
    method TEXT NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('cash', 'bank_transfer', 'cheque', 'card', 'wallet', 'other')),
    reference TEXT,
    notes TEXT,
    recorded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reversed_at TIMESTAMPTZ,
    reversed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    reversal_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON public.invoice_payments(invoice_id);

-- ---------------------------------------------------------------- 8. gapless numbering
CREATE TABLE IF NOT EXISTS public.invoice_number_seq (
    year INTEGER PRIMARY KEY,
    last_value INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- 9. audit log (append-only)
CREATE TABLE IF NOT EXISTS public.finance_audit_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor UUID,
    table_name TEXT NOT NULL,
    row_id TEXT,
    action TEXT NOT NULL,
    old_data JSONB,
    new_data JSONB
);
CREATE INDEX IF NOT EXISTS idx_finance_audit_row ON public.finance_audit_log(table_name, row_id, at);

CREATE OR REPLACE FUNCTION public.fin_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor UUID;
  v_row JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  BEGIN
    v_actor := nullif(current_setting('app.actor', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_actor := NULL;
  END;
  v_actor := coalesce(v_actor, auth.uid());
  INSERT INTO public.finance_audit_log (actor, table_name, row_id, action, old_data, new_data)
  VALUES (v_actor, TG_TABLE_NAME, coalesce(v_row->>'id', v_row->>'client_id', v_row->>'year'), TG_OP,
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_block_change()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only / cannot be deleted: use the void / reverse actions', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

-- ---------------------------------------------------------------- 10. money math
-- Half away from zero to 2 decimals (= half-up for the positive amounts used here).
CREATE OR REPLACE FUNCTION public.fin_round(n NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT round(n, 2) $$;

-- Per-line figures, computed on every insert/update. Items of an issued invoice are frozen.
CREATE OR REPLACE FUNCTION public.fin_item_calc()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF current_setting('app.migrating', true) = 'on' THEN RETURN NEW; END IF;   -- migrated lines keep the old invoice's exact figures
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft invoice can be changed (this one is %)', v_status USING ERRCODE = '42501';
  END IF;
  NEW.line_gross    := public.fin_round(NEW.quantity * NEW.unit_price);
  NEW.line_discount := public.fin_round(NEW.line_gross * NEW.discount_pct / 100);
  NEW.line_net      := NEW.line_gross - NEW.line_discount;
  NEW.line_vat      := public.fin_round(NEW.line_net * NEW.vat_rate / 100);
  NEW.line_total    := NEW.line_net + NEW.line_vat;
  RETURN NEW;
END;
$$;

-- Pure function used by the tests and by the UI preview endpoint: one line.
CREATE OR REPLACE FUNCTION public.fin_calc_line(p_qty NUMERIC, p_price NUMERIC, p_discount_pct NUMERIC, p_vat_rate NUMERIC)
RETURNS TABLE (gross NUMERIC, discount NUMERIC, net NUMERIC, vat NUMERIC, total NUMERIC)
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  WITH g AS (SELECT public.fin_round(p_qty * p_price) AS gross),
       d AS (SELECT gross, public.fin_round(gross * p_discount_pct / 100) AS discount FROM g),
       n AS (SELECT gross, discount, gross - discount AS net FROM d)
  SELECT gross, discount, net, public.fin_round(net * p_vat_rate / 100), net + public.fin_round(net * p_vat_rate / 100) FROM n;
$$;

-- Totals of an invoice = sum of its (already rounded) lines; withholding is on the net amount (excl. VAT).
CREATE OR REPLACE FUNCTION public.fin_recalc_invoice(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_sub NUMERIC; v_disc NUMERIC; v_vat NUMERIC; v_wht_rate NUMERIC; v_wht NUMERIC; v_total NUMERIC; v_paid NUMERIC;
BEGIN
  SELECT coalesce(sum(line_net), 0), coalesce(sum(line_discount), 0), coalesce(sum(line_vat), 0)
    INTO v_sub, v_disc, v_vat FROM public.invoice_items WHERE invoice_id = p_id;
  SELECT withholding_rate INTO v_wht_rate FROM public.invoices WHERE id = p_id;
  v_wht := public.fin_round(v_sub * coalesce(v_wht_rate, 0) / 100);
  v_total := v_sub + v_vat;
  SELECT coalesce(sum(amount), 0) INTO v_paid FROM public.invoice_payments WHERE invoice_id = p_id AND reversed_at IS NULL;
  UPDATE public.invoices SET
    subtotal = v_sub, discount_total = v_disc, vat_amount = v_vat, withholding_amount = v_wht, total = v_total,
    net_receivable = v_total - v_wht, amount_paid = v_paid, balance = (v_total - v_wht) - v_paid,
    amount = v_sub, tax = v_vat                       -- legacy columns kept in step
  WHERE id = p_id;
END;
$$;

-- draft / sent / partially_paid / paid / overdue follow the payments and the due date
CREATE OR REPLACE FUNCTION public.fin_refresh_status(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE; v_new TEXT;
BEGIN
  SELECT * INTO r FROM public.invoices WHERE id = p_id;
  IF r.id IS NULL OR r.status IN ('draft', 'void') THEN RETURN; END IF;
  v_new := CASE
    WHEN r.net_receivable > 0 AND r.amount_paid >= r.net_receivable THEN 'paid'
    WHEN r.amount_paid > 0 THEN CASE WHEN r.due_date < current_date THEN 'overdue' ELSE 'partially_paid' END
    WHEN r.due_date < current_date THEN 'overdue'
    ELSE 'sent' END;
  IF v_new <> r.status THEN
    UPDATE public.invoices SET status = v_new,
      paid_date = CASE WHEN v_new = 'paid' THEN current_date ELSE NULL END WHERE id = p_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_next_invoice_number(p_year INTEGER)
RETURNS TEXT LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_n INTEGER; v_prefix TEXT;
BEGIN
  SELECT invoice_prefix INTO v_prefix FROM public.finance_settings WHERE id;
  INSERT INTO public.invoice_number_seq (year, last_value) VALUES (p_year, 1)
  ON CONFLICT (year) DO UPDATE SET last_value = public.invoice_number_seq.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN v_prefix || '-' || p_year || '-' || lpad(v_n::text, 4, '0');
END;
$$;

-- ---------------------------------------------------------------- 11. immutability of issued invoices
CREATE OR REPLACE FUNCTION public.fin_invoice_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.migrating', true) = 'on' THEN RETURN NEW; END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'A voided invoice cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
    OR NEW.total IS DISTINCT FROM OLD.total OR NEW.withholding_amount IS DISTINCT FROM OLD.withholding_amount
    OR NEW.withholding_rate IS DISTINCT FROM OLD.withholding_rate OR NEW.discount_total IS DISTINCT FROM OLD.discount_total) THEN
    RAISE EXCEPTION 'An issued invoice cannot be edited: void it and create a new one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_payment_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.migrating', true) = 'on' THEN RETURN NEW; END IF;
  -- only the reversal columns may ever change
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.method IS DISTINCT FROM OLD.method
     OR OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payments cannot be edited: reverse the payment and record a new one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 12. migrate the existing invoices (kept in place)
SELECT set_config('app.migrating', 'on', false);

UPDATE public.invoices SET
    kind = CASE WHEN type = 'payable' THEN 'payable' ELSE 'adhoc' END,
    subtotal = amount, vat_amount = tax, discount_total = 0, withholding_rate = 0, withholding_amount = 0,
    total = amount + tax,                       -- the old page computed total = amount + tax; keep totals consistent with the lines
    net_receivable = amount + tax,
    amount_paid = CASE WHEN status = 'paid' THEN amount + tax ELSE 0 END,
    balance = CASE WHEN status = 'paid' THEN 0 ELSE amount + tax END,
    issue_date = coalesce(issue_date, created_at::date),
    issued_at = coalesce(issued_at, created_at),
    void_reason = CASE WHEN status = 'void' THEN coalesce(void_reason, 'Cancelled before the finance upgrade') ELSE void_reason END
WHERE issue_date IS NULL;

-- one line per old invoice (VAT rate derived from its tax / amount), only if it has none yet
INSERT INTO public.invoice_items (invoice_id, position, description_en, quantity, unit_price, vat_rate,
                                  line_gross, line_discount, line_net, line_vat, line_total)
SELECT i.id, 1, 'Invoice ' || i.invoice_number || ' (migrated)', 1, i.amount,
       CASE WHEN i.amount > 0 THEN least(100, round(i.tax / i.amount * 100, 2)) ELSE 0 END,
       i.amount, 0, i.amount, i.tax, i.amount + i.tax
FROM public.invoices i
WHERE NOT EXISTS (SELECT 1 FROM public.invoice_items x WHERE x.invoice_id = i.id);

-- old "paid" invoices become one full payment
INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, notes)
SELECT i.id, i.amount + i.tax, coalesce(i.paid_date, i.created_at::date), 'other', 'Migrated from the previous finance page'
FROM public.invoices i
WHERE i.status = 'paid' AND i.amount + i.tax > 0
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id);

SELECT set_config('app.migrating', 'off', false);

-- ---------------------------------------------------------------- 13. triggers
DROP TRIGGER IF EXISTS fin_item_calc ON public.invoice_items;
CREATE TRIGGER fin_item_calc BEFORE INSERT OR UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.fin_item_calc();

DROP TRIGGER IF EXISTS fin_invoice_guard ON public.invoices;
CREATE TRIGGER fin_invoice_guard BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.fin_invoice_guard();

DROP TRIGGER IF EXISTS fin_payment_guard ON public.invoice_payments;
CREATE TRIGGER fin_payment_guard BEFORE UPDATE ON public.invoice_payments FOR EACH ROW EXECUTE FUNCTION public.fin_payment_guard();

DROP TRIGGER IF EXISTS fin_no_delete ON public.invoices;
CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.fin_block_change();
DROP TRIGGER IF EXISTS fin_no_delete ON public.invoice_payments;
CREATE TRIGGER fin_no_delete BEFORE DELETE ON public.invoice_payments FOR EACH ROW EXECUTE FUNCTION public.fin_block_change();
DROP TRIGGER IF EXISTS fin_no_change ON public.finance_audit_log;
CREATE TRIGGER fin_no_change BEFORE UPDATE OR DELETE ON public.finance_audit_log FOR EACH ROW EXECUTE FUNCTION public.fin_block_change();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_items', 'invoice_payments', 'retainer_plans', 'client_billing', 'finance_settings', 'invoice_number_seq'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER fin_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_audit()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['retainer_plans', 'client_billing', 'finance_settings'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at' AND pronamespace = 'public'::regnamespace) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
      EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 14. write functions (service_role only)
CREATE OR REPLACE FUNCTION public.fin_set_actor(p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$ BEGIN PERFORM set_config('app.actor', coalesce(p_actor::text, ''), true); END; $$;

-- Create or replace a DRAFT invoice and its lines from a JSON document. Totals are computed here.
-- p: { id?, client_id, kind, department_id?, project_id?, task_id?, issue_date?, due_date?, language?, notes?,
--      withholding_rate?, items: [{ description_ar?, description_en?, quantity, unit_price, discount_pct?, vat_rate?, item_code? }] }
CREATE OR REPLACE FUNCTION public.fin_invoice_save(p_actor UUID, p JSONB)
RETURNS UUID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_id UUID := nullif(p->>'id', '')::uuid;
  v_client UUID := nullif(p->>'client_id', '')::uuid;
  v_set public.finance_settings%ROWTYPE;
  v_bill public.client_billing%ROWTYPE;
  v_kind TEXT := coalesce(nullif(p->>'kind', ''), 'adhoc');
  v_issue DATE := coalesce(nullif(p->>'issue_date', '')::date, current_date);
  v_terms INTEGER; v_due DATE; v_wht NUMERIC; v_lang TEXT;
  v_status TEXT; it JSONB; v_pos INTEGER := 0;
  v_qty NUMERIC; v_price NUMERIC; v_disc NUMERIC; v_vat NUMERIC;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client) THEN RAISE EXCEPTION 'Choose a client'; END IF;
  IF v_kind NOT IN ('retainer', 'project', 'adhoc') THEN RAISE EXCEPTION 'Unknown invoice kind'; END IF;
  IF jsonb_typeof(p->'items') <> 'array' OR jsonb_array_length(p->'items') = 0 THEN RAISE EXCEPTION 'Add at least one line item'; END IF;
  IF jsonb_array_length(p->'items') > 100 THEN RAISE EXCEPTION 'Too many line items'; END IF;

  SELECT * INTO v_set FROM public.finance_settings WHERE id;
  SELECT * INTO v_bill FROM public.client_billing WHERE client_id = v_client;
  v_terms := coalesce(v_bill.payment_terms_days, v_set.default_payment_terms_days);
  v_due := coalesce(nullif(p->>'due_date', '')::date, v_issue + v_terms);
  IF v_due < v_issue THEN RAISE EXCEPTION 'The due date cannot be before the issue date'; END IF;
  v_wht := coalesce(nullif(p->>'withholding_rate', '')::numeric, v_bill.withholding_rate, v_set.default_withholding_rate);
  IF v_wht < 0 OR v_wht > 100 THEN RAISE EXCEPTION 'Withholding rate must be between 0 and 100'; END IF;
  v_lang := coalesce(nullif(p->>'language', ''), v_bill.invoice_language, 'both');
  IF v_lang NOT IN ('ar', 'en', 'both') THEN RAISE EXCEPTION 'Unknown language'; END IF;

  IF v_id IS NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO public.invoices (id, invoice_number, client_id, type, kind, status, due_date, issue_date, language,
        department_id, project_id, task_id, withholding_rate, notes, created_by, currency)
    VALUES (v_id, 'DRAFT-' || substr(v_id::text, 1, 8), v_client, 'receivable', v_kind, 'draft', v_due, v_issue, v_lang,
        nullif(p->>'department_id', '')::uuid, nullif(p->>'project_id', '')::uuid, nullif(p->>'task_id', '')::uuid,
        v_wht, nullif(p->>'notes', ''), p_actor, v_set.currency);
  ELSE
    SELECT status INTO v_status FROM public.invoices WHERE id = v_id FOR UPDATE;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'Only a draft invoice can be edited'; END IF;
    UPDATE public.invoices SET client_id = v_client, kind = v_kind, due_date = v_due, issue_date = v_issue, language = v_lang,
        department_id = nullif(p->>'department_id', '')::uuid, project_id = nullif(p->>'project_id', '')::uuid,
        task_id = nullif(p->>'task_id', '')::uuid, withholding_rate = v_wht, notes = nullif(p->>'notes', '')
      WHERE id = v_id;
    DELETE FROM public.invoice_items WHERE invoice_id = v_id;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
    v_pos := v_pos + 1;
    v_qty := (it->>'quantity')::numeric;
    v_price := (it->>'unit_price')::numeric;
    v_disc := coalesce(nullif(it->>'discount_pct', '')::numeric, 0);
    v_vat := coalesce(nullif(it->>'vat_rate', '')::numeric, v_set.vat_rate);
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Line %: quantity must be greater than zero', v_pos; END IF;
    IF v_price IS NULL OR v_price < 0 THEN RAISE EXCEPTION 'Line %: unit price cannot be negative', v_pos; END IF;
    IF v_disc < 0 OR v_disc > 100 THEN RAISE EXCEPTION 'Line %: discount must be between 0 and 100', v_pos; END IF;
    IF v_vat < 0 OR v_vat > 100 THEN RAISE EXCEPTION 'Line %: VAT must be between 0 and 100', v_pos; END IF;
    IF coalesce(it->>'description_ar', '') = '' AND coalesce(it->>'description_en', '') = '' THEN
      RAISE EXCEPTION 'Line %: add a description', v_pos;
    END IF;
    INSERT INTO public.invoice_items (invoice_id, position, description_ar, description_en, quantity, unit_price, discount_pct, vat_rate, item_code, unit_type)
    VALUES (v_id, v_pos, nullif(it->>'description_ar', ''), nullif(it->>'description_en', ''), v_qty, v_price, v_disc, v_vat,
            nullif(it->>'item_code', ''), coalesce(nullif(it->>'unit_type', ''), 'EA'));
  END LOOP;

  PERFORM public.fin_recalc_invoice(v_id);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_invoice_issue(p_actor UUID, p_id UUID)
RETURNS TEXT LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE; v_no TEXT;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  SELECT * INTO r FROM public.invoices WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'This invoice was already issued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_items WHERE invoice_id = p_id) THEN RAISE EXCEPTION 'Add at least one line item'; END IF;
  PERFORM public.fin_recalc_invoice(p_id);
  SELECT * INTO r FROM public.invoices WHERE id = p_id;
  IF r.total <= 0 THEN RAISE EXCEPTION 'An invoice must have a total greater than zero'; END IF;
  -- the number is taken only now, in this same transaction, so numbers stay sequential with no gaps
  v_no := public.fin_next_invoice_number(extract(year FROM coalesce(r.issue_date, current_date))::int);
  UPDATE public.invoices SET invoice_number = v_no, status = 'sent', issued_at = now(), issued_by = p_actor,
      issue_date = coalesce(issue_date, current_date) WHERE id = p_id;
  PERFORM public.fin_refresh_status(p_id);
  RETURN v_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_invoice_void(p_actor UUID, p_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for voiding'; END IF;
  SELECT * INTO r FROM public.invoices WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF r.status = 'void' THEN RAISE EXCEPTION 'This invoice is already void'; END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_payments WHERE invoice_id = p_id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'Reverse the payments of this invoice before voiding it';
  END IF;
  UPDATE public.invoices SET status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = p_actor, balance = 0 WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_payment_add(p_actor UUID, p_invoice UUID, p_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT, p_notes TEXT)
RETURNS UUID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE; v_id UUID; v_amount NUMERIC := public.fin_round(p_amount);
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  SELECT * INTO r FROM public.invoices WHERE id = p_invoice FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF r.status IN ('draft', 'void', 'paid') THEN RAISE EXCEPTION 'You cannot record a payment on a % invoice', r.status; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'The payment amount must be greater than zero'; END IF;
  IF v_amount > r.balance THEN RAISE EXCEPTION 'The payment (%) is more than the balance due (%)', v_amount, r.balance; END IF;
  IF p_paid_on IS NULL OR p_paid_on > current_date THEN RAISE EXCEPTION 'The payment date cannot be in the future'; END IF;
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, notes, recorded_by)
  VALUES (p_invoice, v_amount, p_paid_on, coalesce(nullif(p_method, ''), 'bank_transfer'), nullif(p_reference, ''), nullif(p_notes, ''), p_actor)
  RETURNING id INTO v_id;
  PERFORM public.fin_recalc_invoice(p_invoice);
  PERFORM public.fin_refresh_status(p_invoice);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_payment_reverse(p_actor UUID, p_payment UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoice_payments%ROWTYPE;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for reversing the payment'; END IF;
  SELECT * INTO r FROM public.invoice_payments WHERE id = p_payment FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF r.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'This payment was already reversed'; END IF;
  UPDATE public.invoice_payments SET reversed_at = now(), reversed_by = p_actor, reversal_reason = btrim(p_reason) WHERE id = p_payment;
  PERFORM public.fin_recalc_invoice(r.invoice_id);
  PERFORM public.fin_refresh_status(r.invoice_id);
END;
$$;

-- Marks unpaid invoices past their due date. Run daily by the retainer-billing function.
CREATE OR REPLACE FUNCTION public.fin_mark_overdue()
RETURNS INTEGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_n INTEGER;
BEGIN
  PERFORM public.fin_set_actor(NULL);
  WITH u AS (
    UPDATE public.invoices SET status = 'overdue'
    WHERE status IN ('sent', 'partially_paid') AND due_date < current_date AND balance > 0 RETURNING 1)
  SELECT count(*) INTO v_n FROM u;
  RETURN v_n;
END;
$$;

-- Creates (as drafts, for a person to review and send) the invoice of every active retainer plan for one month.
-- Safe to run repeatedly: a plan never gets two invoices for the same month.
CREATE OR REPLACE FUNCTION public.fin_retainer_generate(p_actor UUID, p_month DATE)
RETURNS INTEGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  m DATE := date_trunc('month', p_month)::date;
  mend DATE := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  pl public.retainer_plans%ROWTYPE; v_n INTEGER := 0; v_id UUID;
  v_label_en TEXT; v_label_ar TEXT;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  v_label_en := to_char(m, 'FMMonth YYYY');
  v_label_ar := to_char(m, 'YYYY-MM');
  FOR pl IN
    SELECT * FROM public.retainer_plans
    WHERE is_active AND start_date <= mend AND (end_date IS NULL OR end_date >= m)
      AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.retainer_plan_id = retainer_plans.id AND i.period_month = m AND i.status <> 'void')
  LOOP
    v_id := public.fin_invoice_save(p_actor, jsonb_build_object(
      'client_id', pl.client_id, 'kind', 'retainer', 'department_id', pl.department_id,
      'issue_date', (m + (pl.billing_day - 1))::text,
      'items', jsonb_build_array(jsonb_build_object(
        'description_en', coalesce(pl.description_en, pl.name) || ' — ' || v_label_en,
        'description_ar', coalesce(pl.description_ar, pl.name) || ' — ' || v_label_ar,
        'quantity', 1, 'unit_price', pl.monthly_fee))));
    UPDATE public.invoices SET retainer_plan_id = pl.id, period_month = m WHERE id = v_id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_settings_update(p_actor UUID, p JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  UPDATE public.finance_settings SET
    vat_rate = coalesce(nullif(p->>'vat_rate', '')::numeric, vat_rate),
    default_withholding_rate = coalesce(nullif(p->>'default_withholding_rate', '')::numeric, default_withholding_rate),
    default_payment_terms_days = coalesce(nullif(p->>'default_payment_terms_days', '')::int, default_payment_terms_days),
    invoice_prefix = coalesce(nullif(upper(p->>'invoice_prefix'), ''), invoice_prefix),
    company_name_en = coalesce(nullif(p->>'company_name_en', ''), company_name_en),
    company_name_ar = coalesce(nullif(p->>'company_name_ar', ''), company_name_ar),
    address_en = CASE WHEN p ? 'address_en' THEN nullif(p->>'address_en', '') ELSE address_en END,
    address_ar = CASE WHEN p ? 'address_ar' THEN nullif(p->>'address_ar', '') ELSE address_ar END,
    phone = CASE WHEN p ? 'phone' THEN nullif(p->>'phone', '') ELSE phone END,
    email = CASE WHEN p ? 'email' THEN nullif(p->>'email', '') ELSE email END,
    tax_registration_no = CASE WHEN p ? 'tax_registration_no' THEN nullif(p->>'tax_registration_no', '') ELSE tax_registration_no END,
    commercial_register_no = CASE WHEN p ? 'commercial_register_no' THEN nullif(p->>'commercial_register_no', '') ELSE commercial_register_no END,
    bank_details = CASE WHEN p ? 'bank_details' THEN nullif(p->>'bank_details', '') ELSE bank_details END,
    updated_by = p_actor, updated_at = now()
  WHERE id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_billing_save(p_actor UUID, p JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_client UUID := nullif(p->>'client_id', '')::uuid;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client) THEN RAISE EXCEPTION 'Client not found'; END IF;
  INSERT INTO public.client_billing (client_id, billing_type, legal_name_ar, legal_name_en, tax_registration_no, billing_address,
      billing_email, withholding_rate, payment_terms_days, invoice_language, eta_receiver_type, updated_by)
  VALUES (v_client, coalesce(nullif(p->>'billing_type', ''), 'on_demand'), nullif(p->>'legal_name_ar', ''), nullif(p->>'legal_name_en', ''),
      nullif(p->>'tax_registration_no', ''), nullif(p->>'billing_address', ''), nullif(p->>'billing_email', ''),
      nullif(p->>'withholding_rate', '')::numeric, nullif(p->>'payment_terms_days', '')::int,
      coalesce(nullif(p->>'invoice_language', ''), 'both'), coalesce(nullif(p->>'eta_receiver_type', ''), 'B'), p_actor)
  ON CONFLICT (client_id) DO UPDATE SET
      billing_type = EXCLUDED.billing_type, legal_name_ar = EXCLUDED.legal_name_ar, legal_name_en = EXCLUDED.legal_name_en,
      tax_registration_no = EXCLUDED.tax_registration_no, billing_address = EXCLUDED.billing_address,
      billing_email = EXCLUDED.billing_email, withholding_rate = EXCLUDED.withholding_rate,
      payment_terms_days = EXCLUDED.payment_terms_days, invoice_language = EXCLUDED.invoice_language,
      eta_receiver_type = EXCLUDED.eta_receiver_type, updated_by = p_actor;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_plan_save(p_actor UUID, p JSONB)
RETURNS UUID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_id UUID := nullif(p->>'id', '')::uuid;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF v_id IS NULL THEN
    INSERT INTO public.retainer_plans (client_id, department_id, name, description_ar, description_en, monthly_fee, start_date, end_date, billing_day, is_active, created_by)
    VALUES ((p->>'client_id')::uuid, nullif(p->>'department_id', '')::uuid, p->>'name', nullif(p->>'description_ar', ''), nullif(p->>'description_en', ''),
            (p->>'monthly_fee')::numeric, (p->>'start_date')::date, nullif(p->>'end_date', '')::date,
            coalesce(nullif(p->>'billing_day', '')::int, 1), coalesce((p->>'is_active')::boolean, true), p_actor)
    RETURNING id INTO v_id;
    -- a client with a retainer plan is a retainer client
    INSERT INTO public.client_billing (client_id, billing_type, updated_by) VALUES ((p->>'client_id')::uuid, 'retainer', p_actor)
    ON CONFLICT (client_id) DO UPDATE SET billing_type = 'retainer', updated_by = p_actor;
  ELSE
    UPDATE public.retainer_plans SET department_id = nullif(p->>'department_id', '')::uuid, name = coalesce(p->>'name', name),
        description_ar = nullif(p->>'description_ar', ''), description_en = nullif(p->>'description_en', ''),
        monthly_fee = coalesce(nullif(p->>'monthly_fee', '')::numeric, monthly_fee),
        start_date = coalesce(nullif(p->>'start_date', '')::date, start_date), end_date = nullif(p->>'end_date', '')::date,
        billing_day = coalesce(nullif(p->>'billing_day', '')::int, billing_day), is_active = coalesce((p->>'is_active')::boolean, is_active)
      WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'fin_set_actor(uuid)', 'fin_invoice_save(uuid,jsonb)', 'fin_invoice_issue(uuid,uuid)', 'fin_invoice_void(uuid,uuid,text)',
    'fin_payment_add(uuid,uuid,numeric,date,text,text,text)', 'fin_payment_reverse(uuid,uuid,text)', 'fin_mark_overdue()',
    'fin_retainer_generate(uuid,date)', 'fin_settings_update(uuid,jsonb)', 'fin_billing_save(uuid,jsonb)', 'fin_plan_save(uuid,jsonb)',
    'fin_recalc_invoice(uuid)', 'fin_refresh_status(uuid)', 'fin_next_invoice_number(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
-- pure helpers are harmless to expose (they read nothing)
GRANT EXECUTE ON FUNCTION public.fin_round(numeric), public.fin_calc_line(numeric, numeric, numeric, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------- 15. access: finance tier reads, nobody writes directly
ALTER TABLE public.finance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retainer_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_number_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_audit_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_settings', 'client_billing', 'retainer_plans', 'invoice_items', 'invoice_payments', 'invoice_number_seq', 'finance_audit_log', 'invoices'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['finance_settings', 'client_billing', 'retainer_plans', 'invoice_items', 'invoice_payments', 'invoice_number_seq', 'finance_audit_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "%s_select" ON public.%I FOR SELECT TO authenticated USING (public.auth_is_finance())', t, t);
  END LOOP;
END $$;
REVOKE USAGE, SELECT ON SEQUENCE public.finance_audit_log_id_seq FROM anon, authenticated;

DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated USING (public.auth_is_finance());
DROP POLICY IF EXISTS "invoices_insert" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update" ON public.invoices;
DROP POLICY IF EXISTS "invoices_delete" ON public.invoices;

-- finance people need to see every client to invoice them (adds to the department-scoped policy, does not replace it)
DROP POLICY IF EXISTS "clients_select_finance" ON public.clients;
CREATE POLICY "clients_select_finance" ON public.clients FOR SELECT TO authenticated USING (public.auth_is_finance());

-- finance people also READ the other finance tables (writes to them are handled in the next steps)
DROP POLICY IF EXISTS "expenses_select_finance" ON public.expenses;
CREATE POLICY "expenses_select_finance" ON public.expenses FOR SELECT TO authenticated USING (public.auth_is_finance());
DROP POLICY IF EXISTS "budgets_select_finance" ON public.budgets;
CREATE POLICY "budgets_select_finance" ON public.budgets FOR SELECT TO authenticated USING (public.auth_is_finance());
DROP POLICY IF EXISTS "vendors_select_finance" ON public.vendors;
CREATE POLICY "vendors_select_finance" ON public.vendors FOR SELECT TO authenticated USING (public.auth_is_finance());

-- live updates on the finance screens (row-level security still decides who receives what)
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['invoices', 'invoice_payments', 'retainer_plans', 'client_billing'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
