-- OPTIONAL demo data for the finance module (run by hand in the SQL editor, never part of a migration).
-- Uses the first two clients that exist: gives them a billing profile, one a retainer plan, and creates a few invoices
-- in different states (draft, sent, part-paid, paid) so every screen has something to show. Safe to delete afterwards:
-- void the invoices from the Finance page (invoices are never deleted).
DO $$
DECLARE
  c1 UUID; c2 UUID; inv UUID; plan UUID;
BEGIN
  SELECT id INTO c1 FROM public.clients ORDER BY created_at LIMIT 1;
  SELECT id INTO c2 FROM public.clients WHERE id <> c1 ORDER BY created_at LIMIT 1;
  IF c1 IS NULL THEN RAISE NOTICE 'No clients yet: create a client first.'; RETURN; END IF;

  PERFORM public.fin_billing_save(NULL, jsonb_build_object('client_id', c1, 'billing_type', 'retainer', 'withholding_rate', 1,
    'payment_terms_days', 30, 'invoice_language', 'both', 'tax_registration_no', '100-200-300'));
  plan := public.fin_plan_save(NULL, jsonb_build_object('client_id', c1, 'name', 'Social media management', 'monthly_fee', 8000,
    'start_date', date_trunc('month', current_date)::text, 'billing_day', 1,
    'description_en', 'Social media management', 'description_ar', 'إدارة وسائل التواصل الاجتماعي'));
  PERFORM public.fin_retainer_generate(NULL, current_date);

  inv := public.fin_invoice_save(NULL, jsonb_build_object('client_id', c1, 'kind', 'project', 'withholding_rate', 1, 'items', jsonb_build_array(
    jsonb_build_object('description_en', 'Brand identity design', 'description_ar', 'تصميم هوية بصرية', 'quantity', 1, 'unit_price', 12500),
    jsonb_build_object('description_en', 'Website (5 pages)', 'description_ar', 'موقع إلكتروني (5 صفحات)', 'quantity', 2, 'unit_price', 3250.50))));
  PERFORM public.fin_invoice_issue(NULL, inv);
  PERFORM public.fin_payment_add(NULL, inv, 10000, current_date, 'bank_transfer', 'DEMO-001', 'Demo payment');

  IF c2 IS NOT NULL THEN
    inv := public.fin_invoice_save(NULL, jsonb_build_object('client_id', c2, 'kind', 'adhoc', 'items', jsonb_build_array(
      jsonb_build_object('description_en', 'Photo shoot (half day)', 'description_ar', 'جلسة تصوير (نصف يوم)', 'quantity', 1, 'unit_price', 4500))));
    PERFORM public.fin_invoice_issue(NULL, inv);
    PERFORM public.fin_payment_add(NULL, inv, (SELECT balance FROM public.invoices WHERE id = inv), current_date, 'cash', NULL, 'Paid in full');
    PERFORM public.fin_invoice_save(NULL, jsonb_build_object('client_id', c2, 'kind', 'adhoc', 'items', jsonb_build_array(
      jsonb_build_object('description_en', 'Logo animation', 'quantity', 1, 'unit_price', 3000))));
  END IF;
END $$;
