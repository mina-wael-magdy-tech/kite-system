-- ====================================================================
-- KITE SYSTEM — 033_database_hygiene.sql   (Phase 3.E: F-12, F-18, F-20, F-24, reconciliation)
--
--   F-12  Finance dates use the STUDIO's business date (studio_today(), Africa/Cairo by default), not the server's current_date:
--         "today" for the payment-date check, the overdue marker, the issue date and the invoice number year.
--   F-18  audit_logs is append-only at database level (no UPDATE, DELETE or TRUNCATE; the one exception is the foreign key's own
--         "set user_id to NULL when a profile is deleted", which cannot change anything else). TRUNCATE is also blocked on the
--         finance audit log, invoices, payments and the invoice number sequence.
--   F-20  Every foreign key in the public schema gets a supporting index (created only where none exists).
--   F-24  The `app.migrating` switch that lets 017 load legacy rows past the finance guards now works ONLY for a database
--         operator: fin_migrating() is false for anon, authenticated, service_role and authenticator, whatever the setting says.
--   NEW   integrity_report(): one read-only list of every detector (orphans, drift, stuck clean-up, NOT VALID constraints...).
--
-- THE FUNCTIONS BELOW (section 2) ARE THE FINANCE FUNCTIONS OF 017 / 028 WITH THOSE TWO CHANGES AND NOTHING ELSE
-- (generated mechanically from the 017 and 028 text). Consequence for operations: if 017 is EVER re-run, re-apply 028 AND THEN 033.
--
-- Safe to run more than once. Run AFTER 032 (and 028). Applied manually; never `db push` on live.
-- NOTE: maintenance/remove-test-data.sql deletes audit rows; it now disables / re-enables the audit trigger explicitly.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;  DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
--   DROP TRIGGER IF EXISTS fin_no_truncate ON public.finance_audit_log;  DROP TRIGGER IF EXISTS fin_no_truncate ON public.invoices;
--   DROP TRIGGER IF EXISTS fin_no_truncate ON public.invoice_payments;   DROP TRIGGER IF EXISTS fin_no_truncate ON public.invoice_number_seq;
--   DROP FUNCTION IF EXISTS public.audit_logs_immutable(), public.integrity_report(), public.fin_migrating();   -- (after step 3 below)
--   -- the FK indexes (names idx_fk_*) are harmless; drop them with DROP INDEX IF EXISTS if you want them gone.
--   -- then restore the 017 / 028 function bodies: re-run 017, then 028 (028 is idempotent) and STOP there (do not re-run 033).
-- ====================================================================

-- ---------------------------------------------------------------- 1. F-24: the migration switch is for operators only
CREATE OR REPLACE FUNCTION public.fin_migrating()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT coalesce(current_setting('app.migrating', true), '') = 'on'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin');
$$;
REVOKE ALL ON FUNCTION public.fin_migrating() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_migrating() TO service_role;

-- ---------------------------------------------------------------- 2. F-12 + F-24: the finance functions (generated; see header)
CREATE OR REPLACE FUNCTION public.fin_item_calc()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF public.fin_migrating() THEN RETURN NEW; END IF;   -- migrated lines keep the old invoice's exact figures
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

CREATE OR REPLACE FUNCTION public.fin_invoice_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF public.fin_migrating() THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.fin_payment_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF public.fin_migrating() THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.fin_check_paid_sum()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_id UUID; v_recorded NUMERIC; v_live NUMERIC;
BEGIN
  IF public.fin_migrating() THEN RETURN NULL; END IF;
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
      WHEN v_paid > 0 THEN CASE WHEN r.due_date < public.studio_today() THEN 'overdue' ELSE 'partially_paid' END
      WHEN r.due_date < public.studio_today() THEN 'overdue'
      ELSE 'sent' END;
  END IF;
  UPDATE public.invoices SET
    subtotal = v_sub, discount_total = v_disc, vat_amount = v_vat, withholding_amount = v_wht, total = v_total,
    net_receivable = v_net, amount_paid = v_paid, balance = v_net - v_paid,
    amount = v_sub, tax = v_vat,                       -- legacy columns kept in step
    status = v_status,
    paid_date = CASE WHEN v_status = r.status THEN r.paid_date WHEN v_status = 'paid' THEN public.studio_today() ELSE NULL END
  WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_refresh_status(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE r public.invoices%ROWTYPE; v_new TEXT;
BEGIN
  SELECT * INTO r FROM public.invoices WHERE id = p_id;
  IF r.id IS NULL OR r.status IN ('draft', 'void') THEN RETURN; END IF;
  v_new := CASE
    WHEN r.net_receivable > 0 AND r.amount_paid >= r.net_receivable THEN 'paid'
    WHEN r.amount_paid > 0 THEN CASE WHEN r.due_date < public.studio_today() THEN 'overdue' ELSE 'partially_paid' END
    WHEN r.due_date < public.studio_today() THEN 'overdue'
    ELSE 'sent' END;
  IF v_new <> r.status THEN
    UPDATE public.invoices SET status = v_new,
      paid_date = CASE WHEN v_new = 'paid' THEN public.studio_today() ELSE NULL END WHERE id = p_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_mark_overdue()
RETURNS INTEGER LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE v_n INTEGER;
BEGIN
  PERFORM public.fin_set_actor(NULL);
  WITH u AS (
    UPDATE public.invoices SET status = 'overdue'
    WHERE status IN ('sent', 'partially_paid') AND due_date < public.studio_today() AND balance > 0 RETURNING 1)
  SELECT count(*) INTO v_n FROM u;
  RETURN v_n;
END;
$$;

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
      -- the request must be IDENTICAL to the one that created the payment (invoice, amount, date, method, reference, notes)
      IF ex.invoice_id <> p_invoice OR ex.amount IS DISTINCT FROM v_amount OR ex.paid_on IS DISTINCT FROM p_paid_on
         OR ex.method IS DISTINCT FROM coalesce(nullif(p_method, ''), 'bank_transfer')
         OR ex.reference IS DISTINCT FROM nullif(p_reference, '') OR ex.notes IS DISTINCT FROM nullif(p_notes, '') THEN
        RAISE EXCEPTION 'This request id was already used for a different payment';
      END IF;
      -- an identical replay of a payment that was reversed since is NOT a success: say so, never report it as an active payment
      IF ex.reversed_at IS NOT NULL THEN
        RAISE EXCEPTION 'This payment was already recorded and has since been reversed (%). Record a new payment with a new request id.', to_char(ex.reversed_at, 'YYYY-MM-DD');
      END IF;
      RETURN ex.id;
    END IF;
  END IF;
  IF r.status IN ('draft', 'void', 'paid') THEN RAISE EXCEPTION 'You cannot record a payment on a % invoice', r.status; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'The payment amount must be greater than zero'; END IF;
  IF v_amount > r.balance THEN RAISE EXCEPTION 'The payment (%) is more than the balance due (%)', v_amount, r.balance; END IF;
  IF p_paid_on IS NULL OR p_paid_on > public.studio_today() THEN RAISE EXCEPTION 'The payment date cannot be in the future'; END IF;
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, notes, recorded_by, request_id)
  VALUES (p_invoice, v_amount, p_paid_on, coalesce(nullif(p_method, ''), 'bank_transfer'), nullif(p_reference, ''), nullif(p_notes, ''), p_actor, p_request)
  RETURNING id INTO v_id;
  PERFORM public.fin_recalc_invoice(p_invoice);
  PERFORM public.fin_refresh_status(p_invoice);
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
  v_no := public.fin_next_invoice_number(extract(year FROM coalesce(r.issue_date, public.studio_today()))::int);
  UPDATE public.invoices SET invoice_number = v_no, status = 'sent', issued_at = now(), issued_by = p_actor,
      issue_date = coalesce(issue_date, public.studio_today()) WHERE id = p_id;
  PERFORM public.fin_refresh_status(p_id);
  RETURN v_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_invoice_save(p_actor UUID, p JSONB)
RETURNS UUID LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_id UUID := nullif(p->>'id', '')::uuid;
  v_client UUID := nullif(p->>'client_id', '')::uuid;
  v_set public.finance_settings%ROWTYPE;
  v_bill public.client_billing%ROWTYPE;
  v_kind TEXT := coalesce(nullif(p->>'kind', ''), 'adhoc');
  v_issue DATE := coalesce(nullif(p->>'issue_date', '')::date, public.studio_today());
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

-- privileges are unchanged by CREATE OR REPLACE; stated again so a partial earlier run cannot leave a gap
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['fin_recalc_invoice(uuid)', 'fin_refresh_status(uuid)', 'fin_mark_overdue()', 'fin_payment_add(uuid,uuid,numeric,date,text,text,text,uuid)',
                           'fin_invoice_issue(uuid,uuid)', 'fin_invoice_save(uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fin_check_paid_sum() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 3. F-18: append-only audit logs, TRUNCATE guards
CREATE OR REPLACE FUNCTION public.audit_logs_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;      -- the foreign key's own ON DELETE SET NULL (a profile was removed); actor_id / actor_label keep the attribution
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.audit_logs_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_immutable();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_audit_log', 'invoices', 'invoice_payments', 'invoice_number_seq'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fin_no_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER fin_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fin_block_change()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 4. F-20: a supporting index for every foreign key (deletes and joins)
DO $$
DECLARE r RECORD; v_name TEXT; v_made INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, cl.relname AS rel,
           (SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
           (SELECT string_agg(a.attname, '_' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS suffix
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
                      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
  LOOP
    v_name := 'idx_fk_' || r.rel || '_' || r.suffix;
    IF length(v_name) > 63 THEN v_name := 'idx_fk_' || md5(r.tbl || r.cols); END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%s)', v_name, r.tbl, r.cols);
    v_made := v_made + 1;
  END LOOP;
  RAISE NOTICE '033: % foreign-key index(es) created', v_made;
END $$;

-- ---------------------------------------------------------------- 5. one read-only list of every detector
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
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)), 'migration 033 section 4')
  ) v(check_name, n, hint);
$$;
REVOKE ALL ON FUNCTION public.integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integrity_report() TO service_role;
