-- ====================================================================
-- KITE SYSTEM — 028_finance_integrity.sql   (Phase 3.A: finance integrity)
--
--   F-01  fin_payment_reverse now locks the PARENT INVOICE first (same order as fin_payment_add), and
--         fin_recalc_invoice itself takes the invoice lock, then computes the totals AND the status in ONE UPDATE.
--         (Before: reversing a payment while another payment/reversal was running wrote a stale amount_paid.)
--   F-03  invoice_payments.request_id (client-supplied UUID) + a unique index. fin_payment_add takes it as an optional
--         last argument; repeating a request returns the SAME payment instead of recording a second one.
--   F-04  An invoice cannot be issued without a client (function check + a guard on the draft -> issued transition).
--   F-05  CHECK constraints on invoice amounts / balance / status, and status-transition rules in fin_invoice_guard.
--         The CHECKs are added NOT VALID (enforced for every new write) and are VALIDATED only if the existing data
--         already satisfies them; otherwise the migration prints a NOTICE with the count and leaves them NOT VALID.
--         A deferred constraint trigger also guarantees invoices.amount_paid = sum of the live payments at COMMIT.
--   F-10  Unique index: one ACTIVE retainer plan per client + department + name (created only if no duplicates exist).
--   F-13  An invoice whose net receivable would be zero (100% withholding, no VAT) cannot be saved or issued.
--   F-14  fin_retainer_generate takes an advisory lock per month and skips a plan another run already billed.
--   NEW   fin_reconcile_invoices(): READ-ONLY report of every invoice whose stored figures disagree with its lines and
--         payments (service_role only).
--
-- Nothing is deleted or rewritten: no historical row is updated by this migration.
-- Safe to run more than once. Run AFTER 017 (and 022). Applied manually; never `db push` on live.
--
-- ROLLBACK (no data is lost; request_id values stay in their column):
--   DROP TRIGGER IF EXISTS fin_paid_sum_invoice ON public.invoices;
--   DROP TRIGGER IF EXISTS fin_paid_sum_payment ON public.invoice_payments;
--   DROP FUNCTION IF EXISTS public.fin_check_paid_sum();
--   ALTER TABLE public.invoices
--     DROP CONSTRAINT IF EXISTS invoices_money_nonneg_chk, DROP CONSTRAINT IF EXISTS invoices_paid_within_net_chk,
--     DROP CONSTRAINT IF EXISTS invoices_total_sum_chk,    DROP CONSTRAINT IF EXISTS invoices_balance_chk,
--     DROP CONSTRAINT IF EXISTS invoices_paid_status_chk,  DROP CONSTRAINT IF EXISTS invoices_number_chk;
--   DROP INDEX IF EXISTS public.uq_retainer_plan_active;
--   DROP INDEX IF EXISTS public.uq_invoice_payment_request;
--   DROP FUNCTION IF EXISTS public.fin_reconcile_invoices();
--   DROP FUNCTION IF EXISTS public.fin_payment_add(uuid, uuid, numeric, date, text, text, text, uuid);
--   -- then re-run 017_finance_invoicing.sql (idempotent) to restore the original bodies of the functions replaced below
--   -- (fin_recalc_invoice, fin_payment_reverse, fin_payment_add, fin_invoice_issue, fin_invoice_save,
--   --  fin_retainer_generate, fin_invoice_guard, fin_payment_guard), then 022 is unaffected.
-- ====================================================================

-- ---------------------------------------------------------------- 1. F-03: request id on payments
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payment_request ON public.invoice_payments (request_id) WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fin_payment_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.migrating', true) = 'on' THEN RETURN NEW; END IF;
  -- only the reversal columns may ever change
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payments cannot be edited: reverse the payment and record a new one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 2. F-01: lock first, compute totals + status in one UPDATE
CREATE OR REPLACE FUNCTION public.fin_recalc_invoice(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  r public.invoices%ROWTYPE;
  v_sub NUMERIC; v_disc NUMERIC; v_vat NUMERIC; v_wht NUMERIC; v_total NUMERIC; v_net NUMERIC; v_paid NUMERIC; v_status TEXT;
BEGIN
  SELECT * INTO r FROM public.invoices WHERE id = p_id FOR UPDATE;   -- every writer of an invoice's figures holds this lock
  IF r.id IS NULL THEN RETURN; END IF;
  SELECT coalesce(sum(line_net), 0), coalesce(sum(line_discount), 0), coalesce(sum(line_vat), 0)
    INTO v_sub, v_disc, v_vat FROM public.invoice_items WHERE invoice_id = p_id;
  v_wht := public.fin_round(v_sub * coalesce(r.withholding_rate, 0) / 100);
  v_total := v_sub + v_vat;
  v_net := v_total - v_wht;
  SELECT coalesce(sum(amount), 0) INTO v_paid FROM public.invoice_payments WHERE invoice_id = p_id AND reversed_at IS NULL;
  v_status := r.status;
  IF r.status NOT IN ('draft', 'void') THEN        -- same rule as fin_refresh_status, in the SAME statement as the amounts
    v_status := CASE
      WHEN v_net > 0 AND v_paid >= v_net THEN 'paid'
      WHEN v_paid > 0 THEN CASE WHEN r.due_date < current_date THEN 'overdue' ELSE 'partially_paid' END
      WHEN r.due_date < current_date THEN 'overdue'
      ELSE 'sent' END;
  END IF;
  UPDATE public.invoices SET
    subtotal = v_sub, discount_total = v_disc, vat_amount = v_vat, withholding_amount = v_wht, total = v_total,
    net_receivable = v_net, amount_paid = v_paid, balance = v_net - v_paid,
    amount = v_sub, tax = v_vat,                       -- legacy columns kept in step
    status = v_status,
    paid_date = CASE WHEN v_status = r.status THEN r.paid_date WHEN v_status = 'paid' THEN current_date ELSE NULL END
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_payment_reverse(p_actor UUID, p_payment UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoice_payments%ROWTYPE; v_invoice UUID;
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for reversing the payment'; END IF;
  SELECT invoice_id INTO v_invoice FROM public.invoice_payments WHERE id = p_payment;
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  PERFORM 1 FROM public.invoices WHERE id = v_invoice FOR UPDATE;                 -- parent invoice FIRST (same order as fin_payment_add)
  SELECT * INTO r FROM public.invoice_payments WHERE id = p_payment FOR UPDATE;
  IF r.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'This payment was already reversed'; END IF;
  UPDATE public.invoice_payments SET reversed_at = now(), reversed_by = p_actor, reversal_reason = btrim(p_reason) WHERE id = p_payment;
  PERFORM public.fin_recalc_invoice(v_invoice);
  PERFORM public.fin_refresh_status(v_invoice);
END;
$$;

-- ---------------------------------------------------------------- 3. F-03: idempotent payments (new optional argument)
DROP FUNCTION IF EXISTS public.fin_payment_add(uuid, uuid, numeric, date, text, text, text);
CREATE OR REPLACE FUNCTION public.fin_payment_add(p_actor UUID, p_invoice UUID, p_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT, p_notes TEXT, p_request UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE; ex public.invoice_payments%ROWTYPE; v_id UUID; v_amount NUMERIC := public.fin_round(p_amount);
BEGIN
  PERFORM public.fin_set_actor(p_actor);
  SELECT * INTO r FROM public.invoices WHERE id = p_invoice FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF p_request IS NOT NULL THEN                       -- a repeated request returns the payment it already created
    SELECT * INTO ex FROM public.invoice_payments WHERE request_id = p_request;
    IF FOUND THEN
      IF ex.invoice_id <> p_invoice OR ex.amount IS DISTINCT FROM v_amount OR ex.paid_on IS DISTINCT FROM p_paid_on THEN
        RAISE EXCEPTION 'This request id was already used for a different payment';
      END IF;
      RETURN ex.id;
    END IF;
  END IF;
  IF r.status IN ('draft', 'void', 'paid') THEN RAISE EXCEPTION 'You cannot record a payment on a % invoice', r.status; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'The payment amount must be greater than zero'; END IF;
  IF v_amount > r.balance THEN RAISE EXCEPTION 'The payment (%) is more than the balance due (%)', v_amount, r.balance; END IF;
  IF p_paid_on IS NULL OR p_paid_on > current_date THEN RAISE EXCEPTION 'The payment date cannot be in the future'; END IF;
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, notes, recorded_by, request_id)
  VALUES (p_invoice, v_amount, p_paid_on, coalesce(nullif(p_method, ''), 'bank_transfer'), nullif(p_reference, ''), nullif(p_notes, ''), p_actor, p_request)
  RETURNING id INTO v_id;
  PERFORM public.fin_recalc_invoice(p_invoice);
  PERFORM public.fin_refresh_status(p_invoice);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- 4. F-04 + F-13 + status transitions in the guard
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
  -- status transitions (F-05): an issued invoice never goes back to draft; a draft is issued ('sent') or voided, nothing else
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'An issued invoice cannot go back to draft' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'sent', 'void') THEN
    RAISE EXCEPTION 'A draft invoice must be issued before it can be %', NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'sent' THEN
    IF NEW.type = 'receivable' AND NEW.client_id IS NULL THEN                                   -- F-04
      RAISE EXCEPTION 'Choose a client before issuing this invoice' USING ERRCODE = '42501';
    END IF;
    IF NEW.net_receivable <= 0 THEN                                                             -- F-13
      RAISE EXCEPTION 'Nothing to collect on this invoice (net receivable is zero): lower the withholding rate' USING ERRCODE = '42501';
    END IF;
    IF NEW.invoice_number LIKE 'DRAFT-%' THEN
      RAISE EXCEPTION 'An issued invoice needs its sequential number' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
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
  IF r.type = 'receivable' AND (r.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients WHERE id = r.client_id)) THEN
    RAISE EXCEPTION 'Choose a client before issuing this invoice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_items WHERE invoice_id = p_id) THEN RAISE EXCEPTION 'Add at least one line item'; END IF;
  PERFORM public.fin_recalc_invoice(p_id);
  SELECT * INTO r FROM public.invoices WHERE id = p_id;
  IF r.total <= 0 THEN RAISE EXCEPTION 'An invoice must have a total greater than zero'; END IF;
  IF r.net_receivable <= 0 THEN
    RAISE EXCEPTION 'Nothing to collect on this invoice (net receivable is zero): lower the withholding rate';
  END IF;
  -- the number is taken only now, in this same transaction, so numbers stay sequential with no gaps
  v_no := public.fin_next_invoice_number(extract(year FROM coalesce(r.issue_date, current_date))::int);
  UPDATE public.invoices SET invoice_number = v_no, status = 'sent', issued_at = now(), issued_by = p_actor,
      issue_date = coalesce(issue_date, current_date) WHERE id = p_id;
  PERFORM public.fin_refresh_status(p_id);
  RETURN v_no;
END;
$$;

-- fin_invoice_save = the 017 body, plus: the net receivable of a saved draft must be above zero (F-13)
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
  v_qty NUMERIC; v_price NUMERIC; v_disc NUMERIC; v_vat NUMERIC; v_net NUMERIC;
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
  SELECT net_receivable INTO v_net FROM public.invoices WHERE id = v_id;
  IF v_net <= 0 AND (SELECT total FROM public.invoices WHERE id = v_id) > 0 THEN
    RAISE EXCEPTION 'Nothing to collect on this invoice (net receivable is zero): lower the withholding rate';
  END IF;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------- 5. F-14: concurrent retainer runs skip what another run already billed
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
  -- two runs for the same month queue here; the second then sees the first one's invoices and skips those plans
  PERFORM pg_advisory_xact_lock(hashtext('fin_retainer_generate'), (extract(year FROM m)::int * 12 + extract(month FROM m)::int));
  v_label_en := to_char(m, 'FMMonth YYYY');
  v_label_ar := to_char(m, 'YYYY-MM');
  FOR pl IN
    SELECT * FROM public.retainer_plans
    WHERE is_active AND start_date <= mend AND (end_date IS NULL OR end_date >= m)
      AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.retainer_plan_id = retainer_plans.id AND i.period_month = m AND i.status <> 'void')
  LOOP
    BEGIN
      v_id := public.fin_invoice_save(p_actor, jsonb_build_object(
        'client_id', pl.client_id, 'kind', 'retainer', 'department_id', pl.department_id,
        'issue_date', (m + (pl.billing_day - 1))::text,
        'items', jsonb_build_array(jsonb_build_object(
          'description_en', coalesce(pl.description_en, pl.name) || ' — ' || v_label_en,
          'description_ar', coalesce(pl.description_ar, pl.name) || ' — ' || v_label_ar,
          'quantity', 1, 'unit_price', pl.monthly_fee))));
      UPDATE public.invoices SET retainer_plan_id = pl.id, period_month = m WHERE id = v_id;
      v_n := v_n + 1;
    EXCEPTION WHEN unique_violation THEN
      NULL;   -- another run billed this plan for this month a moment ago: this plan's draft is rolled back, skip it
    END;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------- 6. F-10: one active plan per client + department + name
DO $$
DECLARE v_dups INTEGER;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT 1 FROM public.retainer_plans WHERE is_active
    GROUP BY client_id, lower(btrim(name)), coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
    HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE NOTICE '028: % group(s) of duplicate ACTIVE retainer plans exist; uq_retainer_plan_active was NOT created. Review them (deactivate the extra plans), then re-run this migration.', v_dups;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_retainer_plan_active ON public.retainer_plans
      (client_id, lower(btrim(name)), coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_active;
  END IF;
END $$;

-- ---------------------------------------------------------------- 7. read-only reconciliation (F-01 follow-up)
CREATE OR REPLACE FUNCTION public.fin_reconcile_invoices()
RETURNS TABLE (invoice_id UUID, invoice_number TEXT, status TEXT, problem TEXT, stored NUMERIC, expected NUMERIC)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH p AS (
    SELECT i.id, i.invoice_number, i.status, i.type, i.client_id, i.subtotal, i.vat_amount, i.total, i.net_receivable, i.amount_paid, i.balance,
           (SELECT coalesce(sum(amount), 0) FROM public.invoice_payments x WHERE x.invoice_id = i.id AND x.reversed_at IS NULL) AS paid_live,
           (SELECT coalesce(sum(line_net), 0) FROM public.invoice_items x WHERE x.invoice_id = i.id) AS lines_net,
           (SELECT coalesce(sum(line_vat), 0) FROM public.invoice_items x WHERE x.invoice_id = i.id) AS lines_vat
    FROM public.invoices i)
  SELECT id, invoice_number, status, 'amount_paid differs from the live payments', amount_paid, paid_live FROM p WHERE amount_paid <> paid_live
  UNION ALL SELECT id, invoice_number, status, 'balance differs from net receivable minus amount paid', balance, net_receivable - amount_paid FROM p WHERE status <> 'void' AND balance <> net_receivable - amount_paid
  UNION ALL SELECT id, invoice_number, status, 'total differs from subtotal plus VAT', total, subtotal + vat_amount FROM p WHERE total <> subtotal + vat_amount
  UNION ALL SELECT id, invoice_number, status, 'subtotal differs from the sum of the lines', subtotal, lines_net FROM p WHERE subtotal <> lines_net
  UNION ALL SELECT id, invoice_number, status, 'VAT differs from the sum of the lines', vat_amount, lines_vat FROM p WHERE vat_amount <> lines_vat
  UNION ALL SELECT id, invoice_number, status, 'paid in excess of the net receivable', amount_paid, net_receivable FROM p WHERE paid_live > net_receivable
  UNION ALL SELECT id, invoice_number, status, 'status is paid but a balance remains', balance, 0 FROM p WHERE status = 'paid' AND balance <> 0
  UNION ALL SELECT id, invoice_number, status, 'open invoice with nothing left to pay', balance, NULL FROM p WHERE status IN ('sent', 'partially_paid', 'overdue') AND net_receivable > 0 AND balance = 0
  UNION ALL SELECT id, invoice_number, status, 'live payments on a void invoice', paid_live, 0 FROM p WHERE status = 'void' AND paid_live <> 0
  UNION ALL SELECT id, invoice_number, status, 'issued receivable invoice without a client', NULL, NULL FROM p WHERE status <> 'draft' AND type = 'receivable' AND client_id IS NULL
  UNION ALL SELECT id, invoice_number, status, 'issued invoice still has a draft number', NULL, NULL FROM p WHERE status NOT IN ('draft', 'void') AND invoice_number LIKE 'DRAFT-%'
  UNION ALL SELECT id, invoice_number, status, 'issued invoice with zero net receivable (cannot be paid)', net_receivable, NULL FROM p WHERE status NOT IN ('draft', 'void') AND net_receivable <= 0
  ORDER BY 2, 4;
$$;

-- ---------------------------------------------------------------- 8. F-05: constraints (NOT VALID first; validated only when the data already complies)
DO $$
DECLARE
  c TEXT[]; v_bad BIGINT;
  v_defs TEXT[][] := ARRAY[
    ['invoices_money_nonneg_chk',   'subtotal >= 0 AND discount_total >= 0 AND vat_amount >= 0 AND withholding_amount >= 0 AND total >= 0 AND net_receivable >= 0 AND amount_paid >= 0 AND balance >= 0'],
    ['invoices_paid_within_net_chk','amount_paid <= net_receivable'],
    ['invoices_total_sum_chk',      'total = subtotal + vat_amount'],
    ['invoices_balance_chk',        'status = ''void'' OR balance = net_receivable - amount_paid'],
    ['invoices_paid_status_chk',    'status <> ''paid'' OR balance = 0'],
    ['invoices_number_chk',         'status IN (''draft'', ''void'') OR invoice_number NOT LIKE ''DRAFT-%''']
  ];
BEGIN
  FOREACH c SLICE 1 IN ARRAY v_defs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c[1] AND conrelid = 'public.invoices'::regclass) THEN
      EXECUTE format('ALTER TABLE public.invoices ADD CONSTRAINT %I CHECK (%s) NOT VALID', c[1], c[2]);
    END IF;
    IF NOT (SELECT convalidated FROM pg_constraint WHERE conname = c[1] AND conrelid = 'public.invoices'::regclass) THEN
      EXECUTE format('SELECT count(*) FROM public.invoices WHERE NOT coalesce(%s, false)', c[2]) INTO v_bad;
      IF v_bad = 0 THEN
        EXECUTE format('ALTER TABLE public.invoices VALIDATE CONSTRAINT %I', c[1]);
      ELSE
        RAISE NOTICE '028: % existing invoice(s) violate %; it stays NOT VALID (enforced for new writes only). See fin_reconcile_invoices().', v_bad, c[1];
      END IF;
    END IF;
  END LOOP;
END $$;

-- amount_paid must equal the sum of the live payments when a transaction commits
CREATE OR REPLACE FUNCTION public.fin_check_paid_sum()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_id UUID; v_recorded NUMERIC; v_live NUMERIC;
BEGIN
  IF current_setting('app.migrating', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'invoices' THEN v_id := NEW.id; ELSE v_id := NEW.invoice_id; END IF;
  SELECT amount_paid INTO v_recorded FROM public.invoices WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount), 0) INTO v_live FROM public.invoice_payments WHERE invoice_id = v_id AND reversed_at IS NULL;
  IF v_recorded <> v_live THEN
    RAISE EXCEPTION 'Invoice is out of balance: recorded paid % but its payments total %', v_recorded, v_live USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fin_check_paid_sum() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS fin_paid_sum_invoice ON public.invoices;
CREATE CONSTRAINT TRIGGER fin_paid_sum_invoice AFTER INSERT OR UPDATE OF amount_paid ON public.invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fin_check_paid_sum();
DROP TRIGGER IF EXISTS fin_paid_sum_payment ON public.invoice_payments;
CREATE CONSTRAINT TRIGGER fin_paid_sum_payment AFTER INSERT OR UPDATE ON public.invoice_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fin_check_paid_sum();

-- ---------------------------------------------------------------- 9. privileges (service_role only, like every fin_* function)
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['fin_payment_add(uuid,uuid,numeric,date,text,text,text,uuid)', 'fin_reconcile_invoices()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
