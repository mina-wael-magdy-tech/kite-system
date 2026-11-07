-- ====================================================================
-- KITE SYSTEM — 031_approvals_and_expenses.sql   (Phase 3.C part 2: F-07 content-plan approval, F-15 expenses and budgets)
--
-- CONTENT PLANS (F-07)
--   * The client's feedback / approval is ONE transaction (content_plan_client_feedback): the evidence row (content_feedback)
--     and the plan status change commit together or not at all. A plan that is still a draft cannot be approved.
--   * Approval is invalidated when the approved content changes: any edit of a post's content fields (title, date, time, type,
--     platform, pillar, objective, idea, caption, links, position), adding / removing / reordering a post or a visual, or an edit of
--     the plan's title / subtitle / direction / accent moves an APPROVED plan back to in_review and clears approved_at (audited).
--     Publishing a post (status, publisher, published url / time) does NOT invalidate.
--   * content_post_assets.plan_id must be the plan of its post (composite foreign key); content_feedback likewise.
--
-- EXPENSES (F-15)
--   * Lifecycle (enforced by trigger for every writer): draft -> submitted -> approved | rejected; approved -> paid. Nothing else.
--     After submission the claim's amount, currency, category, owner, department and project cannot change.
--   * expense_decide / expense_submit / expense_mark_paid are single transactions (status change + approval record together),
--     lock the claim row, and re-check that the ACTOR is an executive (super_admin, owner, ceo) for decide / pay.
--     expense_approvals gets one decision per expense (unique, created only if the data has no duplicates).
--   * Currency: the column default becomes EGP (the form already says EGP; the old default was USD). EXISTING rows are not
--     rewritten: DECISION NEEDED whether old 'USD' rows were really EGP (they were entered through a form labelled EGP).
--   * Budgets: budgets.spent is now DERIVED, never typed: approved + paid expenses of the same fiscal year (studio date of
--     creation), same currency as the finance settings, inside the budget's scope (department and/or project; NULL = any).
--     It is recomputed whenever an expense changes status or a budget is saved. Existing budget rows are NOT rewritten;
--     budget_reconciliation() lists the ones whose stored figure differs from the derived one.
--
-- Safe to run more than once. Run AFTER 030. Applied manually; never `db push` on live.
--
-- ROLLBACK (no data changes):
--   DROP TRIGGER IF EXISTS content_posts_approval_guard ON public.content_posts;  DROP TRIGGER IF EXISTS content_assets_approval_guard ON public.content_post_assets;
--   DROP TRIGGER IF EXISTS content_plans_approval_guard ON public.content_plans;  DROP TRIGGER IF EXISTS expenses_status_guard ON public.expenses;
--   DROP TRIGGER IF EXISTS expenses_budget_sync ON public.expenses;  DROP TRIGGER IF EXISTS budgets_spent_calc ON public.budgets;
--   ALTER TABLE public.content_post_assets DROP CONSTRAINT IF EXISTS content_post_assets_plan_post_fk;
--   ALTER TABLE public.content_feedback DROP CONSTRAINT IF EXISTS content_feedback_plan_post_fk;
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_currency_chk;  ALTER TABLE public.expenses ALTER COLUMN currency SET DEFAULT 'USD';
--   DROP INDEX IF EXISTS public.uq_expense_approval_once;  DROP INDEX IF EXISTS public.uq_content_posts_plan_id;
--   DROP FUNCTION IF EXISTS public.content_plan_client_feedback(uuid, text, text, text, uuid, integer), public.content_plan_invalidate(uuid),
--     public.content_posts_approval_guard(), public.content_assets_approval_guard(), public.content_plans_approval_guard(),
--     public.expense_decide(uuid, uuid, text, text), public.expense_submit(uuid, uuid), public.expense_mark_paid(uuid, uuid),
--     public.expenses_status_guard(), public.expenses_budget_sync(), public.budgets_spent_calc(), public.budget_spent_calc(uuid, uuid, integer),
--     public.budget_reconciliation(), public.fin_actor_is_executive(uuid);
-- ====================================================================

-- ---------------------------------------------------------------- 1. content plans
ALTER TABLE public.content_plans ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
-- (existing approved plans keep approved_at NULL = "approved before this was recorded"; nothing is invented)

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_posts_plan_id ON public.content_posts (plan_id, id);

DO $$
DECLARE v_bad BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_post_assets_plan_post_fk') THEN
    ALTER TABLE public.content_post_assets ADD CONSTRAINT content_post_assets_plan_post_fk
      FOREIGN KEY (plan_id, post_id) REFERENCES public.content_posts (plan_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conname = 'content_post_assets_plan_post_fk') THEN
    SELECT count(*) INTO v_bad FROM public.content_post_assets a WHERE a.post_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.content_posts p WHERE p.id = a.post_id AND p.plan_id = a.plan_id);
    IF v_bad = 0 THEN ALTER TABLE public.content_post_assets VALIDATE CONSTRAINT content_post_assets_plan_post_fk;
    ELSE RAISE NOTICE '031: % visual(s) point at a post of ANOTHER plan; content_post_assets_plan_post_fk stays NOT VALID (new writes are checked).', v_bad; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_feedback_plan_post_fk') THEN
    ALTER TABLE public.content_feedback ADD CONSTRAINT content_feedback_plan_post_fk
      FOREIGN KEY (plan_id, post_id) REFERENCES public.content_posts (plan_id, id) ON DELETE SET NULL (post_id) NOT VALID;
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conname = 'content_feedback_plan_post_fk') THEN
    SELECT count(*) INTO v_bad FROM public.content_feedback f WHERE f.post_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.content_posts p WHERE p.id = f.post_id AND p.plan_id = f.plan_id);
    IF v_bad = 0 THEN ALTER TABLE public.content_feedback VALIDATE CONSTRAINT content_feedback_plan_post_fk;
    ELSE RAISE NOTICE '031: % feedback row(s) point at a post of ANOTHER plan; content_feedback_plan_post_fk stays NOT VALID.', v_bad; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_plan_invalidate(p_plan UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.content_plans WHERE id = p_plan FOR UPDATE;   -- wait for a concurrent approval to commit, THEN look at the status (a stale snapshot would miss it)
  UPDATE public.content_plans SET status = 'in_review', approved_at = NULL WHERE id = p_plan AND status = 'approved';
  IF FOUND THEN
    INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, new_data)
    VALUES (auth.uid(), 'CONTENT_PLAN_APPROVAL_INVALIDATED', 'content_plans', p_plan, jsonb_build_object('reason', 'approved content changed'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.content_plan_invalidate(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.content_posts_approval_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM public.content_plan_invalidate(NEW.plan_id);
  ELSIF TG_OP = 'DELETE' THEN PERFORM public.content_plan_invalidate(OLD.plan_id);
  ELSIF (NEW.title, NEW.post_date, NEW.post_time, NEW.content_type, NEW.platform, NEW.pillar, NEW.objective, NEW.idea, NEW.caption, NEW.links, NEW.position, NEW.plan_id)
        IS DISTINCT FROM
        (OLD.title, OLD.post_date, OLD.post_time, OLD.content_type, OLD.platform, OLD.pillar, OLD.objective, OLD.idea, OLD.caption, OLD.links, OLD.position, OLD.plan_id) THEN
    PERFORM public.content_plan_invalidate(NEW.plan_id);
    IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN PERFORM public.content_plan_invalidate(OLD.plan_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.content_posts_approval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS content_posts_approval_guard ON public.content_posts;
CREATE TRIGGER content_posts_approval_guard AFTER INSERT OR UPDATE OR DELETE ON public.content_posts FOR EACH ROW EXECUTE FUNCTION public.content_posts_approval_guard();

CREATE OR REPLACE FUNCTION public.content_assets_approval_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM public.content_plan_invalidate(NEW.plan_id);
  ELSIF TG_OP = 'DELETE' THEN PERFORM public.content_plan_invalidate(OLD.plan_id);
  ELSIF (NEW.post_id, NEW.position, NEW.file_name) IS DISTINCT FROM (OLD.post_id, OLD.position, OLD.file_name) THEN
    PERFORM public.content_plan_invalidate(NEW.plan_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.content_assets_approval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS content_assets_approval_guard ON public.content_post_assets;
CREATE TRIGGER content_assets_approval_guard AFTER INSERT OR UPDATE OR DELETE ON public.content_post_assets FOR EACH ROW EXECUTE FUNCTION public.content_assets_approval_guard();

CREATE OR REPLACE FUNCTION public.content_plans_approval_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.title, NEW.subtitle, NEW.direction, NEW.accent) IS DISTINCT FROM (OLD.title, OLD.subtitle, OLD.direction, OLD.accent) THEN
    NEW.status := 'in_review'; NEW.approved_at := NULL;
    INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, new_data)
    VALUES (auth.uid(), 'CONTENT_PLAN_APPROVAL_INVALIDATED', 'content_plans', NEW.id, jsonb_build_object('reason', 'approved plan details changed'));
  ELSIF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    NEW.approved_at := now();
  ELSIF NEW.status <> 'approved' AND OLD.status = 'approved' THEN
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.content_plans_approval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS content_plans_approval_guard ON public.content_plans;
CREATE TRIGGER content_plans_approval_guard BEFORE UPDATE ON public.content_plans FOR EACH ROW EXECUTE FUNCTION public.content_plans_approval_guard();

-- the client's note / change request / approval: evidence row + status in ONE transaction. Returns the plan's new status.
CREATE OR REPLACE FUNCTION public.content_plan_client_feedback(p_plan UUID, p_kind TEXT, p_author TEXT, p_message TEXT, p_post UUID, p_slide_no INTEGER)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE pl public.content_plans%ROWTYPE; v_title TEXT;
BEGIN
  IF p_kind NOT IN ('note', 'change', 'approve', 'approve_all') THEN RAISE EXCEPTION 'Unknown feedback kind'; END IF;
  SELECT * INTO pl FROM public.content_plans WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found'; END IF;
  IF pl.status = 'draft' THEN RAISE EXCEPTION 'plan_not_open: this plan is not open for review yet'; END IF;
  IF p_post IS NOT NULL THEN
    SELECT title INTO v_title FROM public.content_posts WHERE id = p_post AND plan_id = p_plan;
    IF NOT FOUND THEN RAISE EXCEPTION 'post_not_in_plan: that page does not belong to this plan'; END IF;
  END IF;
  INSERT INTO public.content_feedback (plan_id, post_id, slide_no, slide_title, author_name, kind, message)
  VALUES (p_plan, p_post, CASE WHEN p_kind = 'approve_all' THEN NULL ELSE p_slide_no END, v_title, p_author, p_kind, p_message);
  IF p_kind = 'approve_all' THEN
    UPDATE public.content_plans SET status = 'approved' WHERE id = p_plan;
  ELSIF p_kind = 'change' THEN
    UPDATE public.content_plans SET status = 'changes_requested' WHERE id = p_plan;
  END IF;
  RETURN (SELECT status FROM public.content_plans WHERE id = p_plan);
END;
$$;
REVOKE ALL ON FUNCTION public.content_plan_client_feedback(UUID, TEXT, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_plan_client_feedback(UUID, TEXT, TEXT, TEXT, UUID, INTEGER) TO service_role;

-- ---------------------------------------------------------------- 2. expenses
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.expenses ALTER COLUMN currency SET DEFAULT 'EGP';
SELECT public.ops_add_check('public.expenses', 'expenses_currency_chk', 'currency ~ ''^[A-Z]{3}$''');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.expense_approvals GROUP BY expense_id HAVING count(*) > 1) THEN
    RAISE NOTICE '031: some expenses have more than one approval record; uq_expense_approval_once was NOT created. Review them, then re-run.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_approval_once ON public.expense_approvals (expense_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.expenses_status_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'submitted') OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected'))
            OR (OLD.status = 'approved' AND NEW.status = 'paid')) THEN
      RAISE EXCEPTION 'An expense cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'paid' THEN NEW.paid_at := coalesce(NEW.paid_at, now()); END IF;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.department_id IS DISTINCT FROM OLD.department_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.title IS DISTINCT FROM OLD.title) THEN
    RAISE EXCEPTION 'A submitted expense cannot be edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS expenses_status_guard ON public.expenses;
CREATE TRIGGER expenses_status_guard BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.expenses_status_guard();

CREATE OR REPLACE FUNCTION public.fin_actor_is_executive(p_actor UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.employment_status = 'active')
     AND EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
                 WHERE ur.user_id = p_actor AND r.is_active AND r.name IN ('super_admin', 'owner', 'ceo'));
$$;
REVOKE ALL ON FUNCTION public.fin_actor_is_executive(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_actor_is_executive(UUID) TO service_role;

-- Error messages start with a stable code (the Edge Function maps them to HTTP statuses).
CREATE OR REPLACE FUNCTION public.expense_decide(p_actor UUID, p_expense UUID, p_decision TEXT, p_notes TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE e public.expenses%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'expense_bad_decision: decision must be approved or rejected'; END IF;
  IF NOT public.fin_actor_is_executive(p_actor) THEN RAISE EXCEPTION 'expense_forbidden: Finance privilege required'; END IF;
  SELECT * INTO e FROM public.expenses WHERE id = p_expense FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found: Expense not found'; END IF;
  IF e.submitted_by = p_actor THEN RAISE EXCEPTION 'expense_self_decision: You cannot decide on your own expense'; END IF;
  IF e.status <> 'submitted' THEN RAISE EXCEPTION 'expense_already_decided: Expense is already %', e.status; END IF;
  UPDATE public.expenses SET status = p_decision WHERE id = p_expense;
  INSERT INTO public.expense_approvals (expense_id, approver_id, action, notes) VALUES (p_expense, p_actor, p_decision, p_notes);
  RETURN p_decision;
END;
$$;
CREATE OR REPLACE FUNCTION public.expense_submit(p_actor UUID, p_expense UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE e public.expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = p_expense FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found: Expense not found'; END IF;
  IF e.submitted_by <> p_actor THEN RAISE EXCEPTION 'expense_forbidden: Only the person who wrote the claim can submit it'; END IF;
  IF e.status <> 'draft' THEN RAISE EXCEPTION 'expense_already_decided: Expense is already %', e.status; END IF;
  UPDATE public.expenses SET status = 'submitted' WHERE id = p_expense;
  RETURN 'submitted';
END;
$$;
CREATE OR REPLACE FUNCTION public.expense_mark_paid(p_actor UUID, p_expense UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE e public.expenses%ROWTYPE;
BEGIN
  IF NOT public.fin_actor_is_executive(p_actor) THEN RAISE EXCEPTION 'expense_forbidden: Finance privilege required'; END IF;
  SELECT * INTO e FROM public.expenses WHERE id = p_expense FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'expense_not_found: Expense not found'; END IF;
  IF e.status = 'paid' THEN RAISE EXCEPTION 'expense_already_decided: Expense is already paid'; END IF;
  IF e.status <> 'approved' THEN RAISE EXCEPTION 'expense_not_approved: Only an approved expense can be marked paid (this one is %)', e.status; END IF;
  UPDATE public.expenses SET status = 'paid', paid_at = now(), paid_by = p_actor WHERE id = p_expense;
  RETURN 'paid';
END;
$$;
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['expense_decide(uuid,uuid,text,text)', 'expense_submit(uuid,uuid)', 'expense_mark_paid(uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- 3. budgets: spent is derived
CREATE OR REPLACE FUNCTION public.budget_spent_calc(p_department UUID, p_project UUID, p_year INTEGER)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(sum(e.amount), 0) FROM public.expenses e
  WHERE e.status IN ('approved', 'paid')
    AND e.currency = coalesce((SELECT currency FROM public.finance_settings WHERE id), 'EGP')
    AND (p_department IS NULL OR e.department_id = p_department)
    AND (p_project IS NULL OR e.project_id = p_project)
    AND extract(year FROM public.studio_date(e.created_at))::int = p_year;
$$;
REVOKE ALL ON FUNCTION public.budget_spent_calc(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.budgets_spent_calc()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.spent := public.budget_spent_calc(NEW.department_id, NEW.project_id, NEW.fiscal_year);   -- never typed by hand
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.budgets_spent_calc() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS budgets_spent_calc ON public.budgets;
CREATE TRIGGER budgets_spent_calc BEFORE INSERT OR UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.budgets_spent_calc();

CREATE OR REPLACE FUNCTION public.expenses_budget_sync()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status NOT IN ('approved', 'paid') THEN RETURN NULL; END IF;
  UPDATE public.budgets b SET updated_at = now()     -- the budgets trigger recomputes spent
  WHERE (b.department_id IS NULL OR b.department_id = NEW.department_id) AND (b.project_id IS NULL OR b.project_id = NEW.project_id)
    AND b.fiscal_year = extract(year FROM public.studio_date(NEW.created_at))::int;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.expenses_budget_sync() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS expenses_budget_sync ON public.expenses;
CREATE TRIGGER expenses_budget_sync AFTER INSERT OR UPDATE OF status ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.expenses_budget_sync();

CREATE OR REPLACE FUNCTION public.budget_reconciliation()
RETURNS TABLE (budget_id UUID, name TEXT, stored_spent NUMERIC, derived_spent NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT b.id, b.name, b.spent, public.budget_spent_calc(b.department_id, b.project_id, b.fiscal_year)
  FROM public.budgets b WHERE b.spent IS DISTINCT FROM public.budget_spent_calc(b.department_id, b.project_id, b.fiscal_year);
$$;
REVOKE ALL ON FUNCTION public.budget_reconciliation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.budget_reconciliation() TO service_role;
