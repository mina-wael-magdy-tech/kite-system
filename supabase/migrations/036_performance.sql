-- ====================================================================
-- KITE SYSTEM — 036_performance.sql   (Phase 6: performance and request optimization)
--
-- Additive and reversible. It changes no authorization rule: every rewritten policy is proven row-for-row equivalent
-- (visible rows for SELECT, USING / WITH CHECK truth for every command) by supabase/tests/verify-perf.mjs.
--
--   1. Row-level-security cost (PERF-02).  Measured on 60k tasks: a page of 20 tasks cost 8.8-20 s because every policy
--      called a SECURITY DEFINER helper once PER ROW (auth_can_view_task(id), auth_is_admin(), ...). Now:
--        * a column-free helper call or auth.uid() in a policy is wrapped as (SELECT ...): PostgreSQL evaluates it once per
--          statement (an InitPlan) instead of once per row. Same value, same result.
--        * tasks_select no longer calls auth_can_view_task(id) per row: three SECURITY DEFINER helpers return the caller's
--          id sets once per statement (departments they manage, tasks they are assigned to, projects they manage).
--        * auth_can_view_task(<column>) in the policies of task children (comments, attachments, links, checklists, time
--          entries, handoffs, activity, assignees) becomes EXISTS (SELECT 1 FROM tasks WHERE tasks.id = <column>): the
--          tasks policy above decides, exactly as the function did.
--      The old functions (auth_can_view_task, auth_is_*, ...) are NOT dropped or changed. Policies that call a helper with a
--      column argument (auth_is_dept_manager(department_id), auth_can_see_client(id), ...) are unchanged.
--   2. Indexes for the newest-first lists the screens use (created_at DESC, id): tasks, invoices, expenses, task_attachments,
--      assets, leads.  (CREATE INDEX IF NOT EXISTS; on a big live table run each statement once by hand with CONCURRENTLY.)
--      No index is dropped in this phase.
--   3. Aggregates in the database instead of loading every row into the browser. SECURITY INVOKER, so RLS decides what each
--      person counts, exactly as when the browser summed the rows it was allowed to read:
--        task_stats()                  counts by status / priority / department (reports, dashboard charts)
--        client_task_stats(p_today)    open / done / late tasks and active projects per client (client hub)
--
-- ROLLBACK (no data is touched):  run supabase/maintenance/rollback-036.sql  (restores every original policy, drops the helpers,
-- aggregates and indexes). The original policy text is also in migrations 002-035.
-- ====================================================================

-- ---------------------------------------------------------------- 1a. id-set helpers (evaluated once per statement)
CREATE OR REPLACE FUNCTION public.auth_managed_department_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT d.id FROM public.departments d WHERE d.manager_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.auth_assigned_task_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT ta.task_id FROM public.task_assignees ta WHERE ta.user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.auth_managed_project_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT pr.id FROM public.projects pr WHERE pr.project_manager_id = auth.uid() $$;

REVOKE ALL ON FUNCTION public.auth_managed_department_ids(), public.auth_assigned_task_ids(), public.auth_managed_project_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_managed_department_ids(), public.auth_assigned_task_ids(), public.auth_managed_project_ids() TO authenticated, service_role;

-- ---------------------------------------------------------------- 1b. the rewritten policies (generated, see tests/tools/gen-036-policies.mjs)
ALTER POLICY "assets_delete" ON public.assets USING (((SELECT public.auth_is_staff()) AND
CASE
    WHEN finance_confidential THEN (SELECT public.auth_is_finance())
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_owner()) OR ((SELECT public.auth_is_admin()) AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin()))
END));
ALTER POLICY "assets_insert" ON public.assets WITH CHECK (((SELECT public.auth_is_staff()) AND (uploaded_by = (SELECT auth.uid())) AND ((NOT finance_confidential) OR (SELECT public.auth_is_finance())) AND ((client_id IS NULL) OR auth_can_see_client(client_id))));
ALTER POLICY "assets_select" ON public.assets USING (((SELECT public.auth_is_staff()) AND
CASE
    WHEN finance_confidential THEN (SELECT public.auth_is_finance())
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_owner()) OR (auth_can_see_client(client_id) AND ((visibility = 'studio'::text) OR (SELECT public.auth_is_admin()) OR ((visibility = 'department'::text) AND (EXISTS ( SELECT 1
       FROM user_departments ud
      WHERE ((ud.user_id = (SELECT auth.uid())) AND (ud.department_id = assets.department_id))))))))
    ELSE ((visibility = 'studio'::text) OR (uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin()) OR ((visibility = 'department'::text) AND (EXISTS ( SELECT 1
       FROM user_departments ud
      WHERE ((ud.user_id = (SELECT auth.uid())) AND (ud.department_id = assets.department_id))))))
END));
ALTER POLICY "assets_update" ON public.assets USING (((SELECT public.auth_is_staff()) AND
CASE
    WHEN finance_confidential THEN (SELECT public.auth_is_finance())
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_owner()) OR ((SELECT public.auth_is_admin()) AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin()) OR (SELECT public.auth_is_finance()))
END)) WITH CHECK (((SELECT public.auth_is_staff()) AND
CASE
    WHEN finance_confidential THEN (SELECT public.auth_is_finance())
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_owner()) OR ((SELECT public.auth_is_admin()) AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin()) OR (SELECT public.auth_is_finance()))
END));
ALTER POLICY "attendance_insert" ON public.attendance_records WITH CHECK (((user_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff())));
ALTER POLICY "attendance_select" ON public.attendance_records USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)) OR (user_id = (SELECT auth.uid()))));
ALTER POLICY "attendance_update" ON public.attendance_records USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)) OR ((user_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff())))) WITH CHECK (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)) OR ((user_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff()))));
ALTER POLICY "audit_logs_select" ON public.audit_logs USING (
CASE
    WHEN ((action ~~ 'EXPENSE\_%'::text) OR (entity_type = ANY (ARRAY['expenses'::text, 'expense_approvals'::text, 'invoices'::text, 'invoice_items'::text, 'invoice_payments'::text, 'budgets'::text, 'vendors'::text, 'retainer_plans'::text, 'client_billing'::text, 'finance_settings'::text, 'money_figures'::text]))) THEN (SELECT public.auth_is_finance())
    ELSE (SELECT public.auth_is_admin())
END);
ALTER POLICY "broadcasts_select" ON public.broadcasts USING ((SELECT public.auth_is_admin()));
ALTER POLICY "budgets_delete" ON public.budgets USING ((SELECT public.auth_is_owner()));
ALTER POLICY "budgets_insert" ON public.budgets WITH CHECK ((SELECT public.auth_is_owner()));
ALTER POLICY "budgets_select" ON public.budgets USING ((SELECT public.auth_is_owner()));
ALTER POLICY "budgets_select_finance" ON public.budgets USING ((SELECT public.auth_is_finance()));
ALTER POLICY "budgets_update" ON public.budgets USING ((SELECT public.auth_is_owner())) WITH CHECK ((SELECT public.auth_is_owner()));
ALTER POLICY "campaign_departments_delete" ON public.campaign_departments USING ((SELECT public.auth_is_manager()));
ALTER POLICY "campaign_departments_insert" ON public.campaign_departments WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "campaign_departments_select" ON public.campaign_departments USING ((SELECT public.auth_is_staff()));
ALTER POLICY "campaign_members_delete" ON public.campaign_members USING ((SELECT public.auth_is_manager()));
ALTER POLICY "campaign_members_insert" ON public.campaign_members WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "campaign_members_select" ON public.campaign_members USING ((SELECT public.auth_is_staff()));
ALTER POLICY "campaigns_delete" ON public.campaigns USING ((SELECT public.auth_is_admin()));
ALTER POLICY "campaigns_insert" ON public.campaigns WITH CHECK (((SELECT public.auth_is_manager()) AND ((created_by IS NULL) OR (created_by = (SELECT auth.uid())))));
ALTER POLICY "campaigns_select" ON public.campaigns USING ((SELECT public.auth_is_staff()));
ALTER POLICY "campaigns_update" ON public.campaigns USING (((SELECT public.auth_is_admin()) OR (manager_id = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid())))) WITH CHECK (((SELECT public.auth_is_admin()) OR (manager_id = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid()))));
ALTER POLICY "client_activities_delete" ON public.client_activities USING ((SELECT public.auth_is_manager()));
ALTER POLICY "client_activities_insert" ON public.client_activities WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "client_activities_select" ON public.client_activities USING ((SELECT public.auth_is_manager()));
ALTER POLICY "client_activities_update" ON public.client_activities USING ((SELECT public.auth_is_manager())) WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "client_billing_select" ON public.client_billing USING ((SELECT public.auth_is_finance()));
ALTER POLICY "client_contacts_delete" ON public.client_contacts USING ((SELECT public.auth_is_manager()));
ALTER POLICY "client_contacts_insert" ON public.client_contacts WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "client_contacts_select" ON public.client_contacts USING (((SELECT public.auth_is_manager()) AND auth_can_see_client(client_id)));
ALTER POLICY "client_contacts_update" ON public.client_contacts USING ((SELECT public.auth_is_manager())) WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "client_departments_delete" ON public.client_departments USING ((SELECT public.auth_is_manager()));
ALTER POLICY "client_departments_insert" ON public.client_departments WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "clients_delete" ON public.clients USING ((SELECT public.auth_is_admin()));
ALTER POLICY "clients_insert" ON public.clients WITH CHECK (((SELECT public.auth_is_manager()) AND ((created_by IS NULL) OR (created_by = (SELECT auth.uid())))));
ALTER POLICY "clients_update" ON public.clients USING (((SELECT public.auth_is_manager()) AND auth_can_see_client(id))) WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "company_settings_insert" ON public.company_settings WITH CHECK ((SELECT public.auth_is_admin()));
ALTER POLICY "company_settings_select" ON public.company_settings USING ((SELECT public.auth_is_staff()));
ALTER POLICY "company_settings_update" ON public.company_settings USING ((SELECT public.auth_is_admin())) WITH CHECK ((SELECT public.auth_is_admin()));
ALTER POLICY "feedback_select" ON public.content_feedback USING ((SELECT public.auth_is_staff()));
ALTER POLICY "plans_insert" ON public.content_plans WITH CHECK (((SELECT public.auth_is_staff()) AND (created_by = (SELECT auth.uid()))));
ALTER POLICY "plans_select" ON public.content_plans USING ((SELECT public.auth_is_staff()));
ALTER POLICY "plan_assets_insert" ON public.content_post_assets WITH CHECK ((auth_can_edit_plan(plan_id) AND (uploaded_by = (SELECT auth.uid())) AND ((post_id IS NULL) OR (EXISTS ( SELECT 1
   FROM content_posts p
  WHERE ((p.id = content_post_assets.post_id) AND (p.plan_id = content_post_assets.plan_id)))))));
ALTER POLICY "plan_assets_select" ON public.content_post_assets USING ((SELECT public.auth_is_staff()));
ALTER POLICY "posts_select" ON public.content_posts USING ((SELECT public.auth_is_staff()));
ALTER POLICY "posts_update" ON public.content_posts USING ((auth_can_edit_plan(plan_id) OR ((publisher_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff())))) WITH CHECK ((auth_can_edit_plan(plan_id) OR ((publisher_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff()))));
ALTER POLICY "deleted_users_select" ON public.deleted_users USING ((SELECT public.auth_is_admin()));
ALTER POLICY "departments_delete" ON public.departments USING ((SELECT public.auth_is_admin()));
ALTER POLICY "departments_insert" ON public.departments WITH CHECK ((SELECT public.auth_is_admin()));
ALTER POLICY "departments_select" ON public.departments USING ((SELECT public.auth_is_staff()));
ALTER POLICY "departments_update" ON public.departments USING ((SELECT public.auth_is_admin())) WITH CHECK ((SELECT public.auth_is_admin()));
ALTER POLICY "employee_documents_delete" ON public.employee_documents USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "employee_documents_insert" ON public.employee_documents WITH CHECK ((((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))) AND (uploaded_by = (SELECT auth.uid()))));
ALTER POLICY "employee_documents_select" ON public.employee_documents USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)) OR (user_id = (SELECT auth.uid()))));
ALTER POLICY "expense_approvals_select" ON public.expense_approvals USING ((SELECT public.auth_is_finance()));
ALTER POLICY "expenses_insert" ON public.expenses WITH CHECK (((SELECT public.auth_is_staff()) AND (submitted_by = (SELECT auth.uid())) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text]))));
ALTER POLICY "expenses_select" ON public.expenses USING ((SELECT public.auth_is_finance()));
ALTER POLICY "expenses_select_finance" ON public.expenses USING ((SELECT public.auth_is_finance()));
ALTER POLICY "finance_audit_log_select" ON public.finance_audit_log USING ((SELECT public.auth_is_finance()));
ALTER POLICY "finance_settings_select" ON public.finance_settings USING ((SELECT public.auth_is_finance()));
ALTER POLICY "holidays_delete" ON public.holidays USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "holidays_insert" ON public.holidays WITH CHECK (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "holidays_select" ON public.holidays USING ((SELECT public.auth_is_staff()));
ALTER POLICY "holidays_update" ON public.holidays USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)))) WITH CHECK (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "invitations_select" ON public.invitations USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "invoice_items_select" ON public.invoice_items USING ((SELECT public.auth_is_finance()));
ALTER POLICY "invoice_number_seq_select" ON public.invoice_number_seq USING ((SELECT public.auth_is_finance()));
ALTER POLICY "invoice_payments_select" ON public.invoice_payments USING ((SELECT public.auth_is_finance()));
ALTER POLICY "invoices_select" ON public.invoices USING ((SELECT public.auth_is_finance()));
ALTER POLICY "lead_stage_history_select" ON public.lead_stage_history USING (((SELECT public.auth_is_admin()) OR (EXISTS ( SELECT 1
   FROM leads l
  WHERE (l.id = lead_stage_history.lead_id)))));
ALTER POLICY "leads_delete" ON public.leads USING ((SELECT public.auth_is_admin()));
ALTER POLICY "leads_insert" ON public.leads WITH CHECK (((SELECT public.auth_is_manager()) AND ((created_by IS NULL) OR (created_by = (SELECT auth.uid())))));
ALTER POLICY "leads_select" ON public.leads USING (((SELECT public.auth_is_manager()) OR (assigned_to = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid()))));
ALTER POLICY "leads_update" ON public.leads USING (((SELECT public.auth_is_manager()) OR (assigned_to = (SELECT auth.uid())))) WITH CHECK (((SELECT public.auth_is_manager()) OR (assigned_to = (SELECT auth.uid()))));
ALTER POLICY "leave_requests_insert" ON public.leave_requests WITH CHECK (((user_id = (SELECT auth.uid())) AND (SELECT public.auth_is_staff()) AND (status = 'pending'::text) AND (reviewed_by IS NULL)));
ALTER POLICY "leave_requests_select" ON public.leave_requests USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)) OR (user_id = (SELECT auth.uid()))));
ALTER POLICY "leave_types_delete" ON public.leave_types USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "leave_types_insert" ON public.leave_types WITH CHECK (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "leave_types_select" ON public.leave_types USING ((SELECT public.auth_is_staff()));
ALTER POLICY "leave_types_update" ON public.leave_types USING (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text)))) WITH CHECK (((SELECT public.auth_is_admin()) OR (SELECT public.auth_has_role('hr_manager'::text))));
ALTER POLICY "messages_insert" ON public.messages WITH CHECK (((sender_id = (SELECT auth.uid())) AND (message_type = ANY (ARRAY['text'::text, 'task_handoff'::text, 'voice'::text, 'image'::text, 'file'::text, 'call'::text])) AND auth_can_post_conversation(conversation_id)));
ALTER POLICY "milestones_delete" ON public.milestones USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "milestones_insert" ON public.milestones WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "milestones_update" ON public.milestones USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id))) WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "money_figures_all" ON public.money_figures USING ((SELECT public.auth_is_owner())) WITH CHECK (((SELECT public.auth_is_owner()) AND (NOT (updated_by IS DISTINCT FROM (SELECT auth.uid())))));
ALTER POLICY "notification_preferences_insert" ON public.notification_preferences WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "notification_preferences_select" ON public.notification_preferences USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "notification_preferences_update" ON public.notification_preferences USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "notifications_select" ON public.notifications USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "notifications_update" ON public.notifications USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "opportunities_delete" ON public.opportunities USING ((SELECT public.auth_is_manager()));
ALTER POLICY "opportunities_insert" ON public.opportunities WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "opportunities_select" ON public.opportunities USING ((SELECT public.auth_is_manager()));
ALTER POLICY "opportunities_update" ON public.opportunities USING ((SELECT public.auth_is_manager())) WITH CHECK ((SELECT public.auth_is_manager()));
ALTER POLICY "permissions_select" ON public.permissions USING ((SELECT public.auth_is_staff()));
ALTER POLICY "profiles_select" ON public.profiles USING (((id = (SELECT auth.uid())) OR (SELECT public.auth_is_staff())));
ALTER POLICY "profiles_update_self" ON public.profiles USING (((id = (SELECT auth.uid())) AND (SELECT public.auth_is_active()))) WITH CHECK ((id = (SELECT auth.uid())));
ALTER POLICY "project_departments_delete" ON public.project_departments USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "project_departments_insert" ON public.project_departments WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "project_departments_update" ON public.project_departments USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id))) WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_delete" ON public.project_members USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_insert" ON public.project_members WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_update" ON public.project_members USING (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id))) WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_project_manager(project_id)));
ALTER POLICY "projects_delete" ON public.projects USING ((SELECT public.auth_is_admin()));
ALTER POLICY "projects_insert" ON public.projects WITH CHECK (((SELECT public.auth_is_manager()) AND ((created_by IS NULL) OR (created_by = (SELECT auth.uid())))));
ALTER POLICY "projects_update" ON public.projects USING (((SELECT public.auth_is_admin()) OR (project_manager_id = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid())))) WITH CHECK (((SELECT public.auth_is_admin()) OR (project_manager_id = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid()))));
ALTER POLICY "push_subscriptions_select" ON public.push_subscriptions USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "retainer_plans_select" ON public.retainer_plans USING ((SELECT public.auth_is_finance()));
ALTER POLICY "role_permissions_select" ON public.role_permissions USING ((SELECT public.auth_is_staff()));
ALTER POLICY "roles_select" ON public.roles USING ((SELECT public.auth_is_staff()));
ALTER POLICY "task_activity_logs_select" ON public.task_activity_logs USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_activity_logs.task_id))));
ALTER POLICY "task_assignees_select" ON public.task_assignees USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_assignees.task_id))));
ALTER POLICY "task_attachments_delete" ON public.task_attachments USING (((uploaded_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin())));
ALTER POLICY "task_attachments_insert" ON public.task_attachments WITH CHECK (((uploaded_by = (SELECT auth.uid())) AND (EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_attachments.task_id)))));
ALTER POLICY "task_attachments_select" ON public.task_attachments USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_attachments.task_id))));
ALTER POLICY "task_checklists_delete" ON public.task_checklists USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_checklists.task_id))));
ALTER POLICY "task_checklists_insert" ON public.task_checklists WITH CHECK ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_checklists.task_id))));
ALTER POLICY "task_checklists_select" ON public.task_checklists USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_checklists.task_id))));
ALTER POLICY "task_checklists_update" ON public.task_checklists USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_checklists.task_id)))) WITH CHECK ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_checklists.task_id))));
ALTER POLICY "task_comments_insert" ON public.task_comments WITH CHECK (((user_id = (SELECT auth.uid())) AND (is_system_message = false) AND (EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_comments.task_id)))));
ALTER POLICY "task_comments_select" ON public.task_comments USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_comments.task_id))));
ALTER POLICY "task_handoffs_select" ON public.task_handoffs USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_handoffs.task_id))));
ALTER POLICY "task_links_delete" ON public.task_links USING (((added_by = (SELECT auth.uid())) OR (SELECT public.auth_is_admin())));
ALTER POLICY "task_links_insert" ON public.task_links WITH CHECK (((added_by = (SELECT auth.uid())) AND (EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_links.task_id)))));
ALTER POLICY "task_links_select" ON public.task_links USING ((EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_links.task_id))));
ALTER POLICY "task_time_entries_delete" ON public.task_time_entries USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "task_time_entries_insert" ON public.task_time_entries WITH CHECK (((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_time_entries.task_id)))));
ALTER POLICY "task_time_entries_select" ON public.task_time_entries USING (((user_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = task_time_entries.task_id)))));
ALTER POLICY "task_time_entries_update" ON public.task_time_entries USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "tasks_select" ON public.tasks USING (((SELECT public.auth_is_staff()) AND ((SELECT public.auth_is_admin()) OR (assigned_to = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid())) OR ((SELECT public.auth_is_active()) AND (department_id IN (SELECT public.auth_managed_department_ids()))) OR (id IN (SELECT public.auth_assigned_task_ids())) OR ((project_id IS NOT NULL) AND (project_id IN (SELECT public.auth_managed_project_ids()))))));
ALTER POLICY "teams_delete" ON public.teams USING (((SELECT public.auth_is_admin()) OR auth_is_dept_manager(department_id)));
ALTER POLICY "teams_insert" ON public.teams WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_dept_manager(department_id)));
ALTER POLICY "teams_select" ON public.teams USING ((SELECT public.auth_is_staff()));
ALTER POLICY "teams_update" ON public.teams USING (((SELECT public.auth_is_admin()) OR auth_is_dept_manager(department_id))) WITH CHECK (((SELECT public.auth_is_admin()) OR auth_is_dept_manager(department_id)));
ALTER POLICY "user_departments_select" ON public.user_departments USING (((user_id = (SELECT auth.uid())) OR (SELECT public.auth_is_staff())));
ALTER POLICY "user_roles_select" ON public.user_roles USING (((user_id = (SELECT auth.uid())) OR (SELECT public.auth_is_staff())));
ALTER POLICY "vendors_delete" ON public.vendors USING ((SELECT public.auth_is_owner()));
ALTER POLICY "vendors_insert" ON public.vendors WITH CHECK ((SELECT public.auth_is_owner()));
ALTER POLICY "vendors_select" ON public.vendors USING ((SELECT public.auth_is_owner()));
ALTER POLICY "vendors_select_finance" ON public.vendors USING ((SELECT public.auth_is_finance()));
ALTER POLICY "vendors_update" ON public.vendors USING ((SELECT public.auth_is_owner())) WITH CHECK ((SELECT public.auth_is_owner()));

-- ---------------------------------------------------------------- 2. indexes for newest-first lists
CREATE INDEX IF NOT EXISTS idx_tasks_created_desc ON public.tasks (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_desc ON public.invoices (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_expenses_created_desc ON public.expenses (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_task_attachments_created_desc ON public.task_attachments (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_assets_created_desc ON public.assets (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_leads_created_desc ON public.leads (created_at DESC, id);

-- ---------------------------------------------------------------- 3. aggregates (SECURITY INVOKER: RLS decides what is counted)
CREATE OR REPLACE FUNCTION public.task_stats()
RETURNS TABLE (dimension TEXT, key TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT 'status'::text, t.status, count(*) FROM public.tasks t GROUP BY t.status
  UNION ALL
  SELECT 'priority'::text, t.priority, count(*) FROM public.tasks t GROUP BY t.priority
  UNION ALL      -- the dashboard's "active deliverables per department": everything not finished or cancelled; '' = no department
  SELECT 'active_department'::text, coalesce(t.department_id::text, ''), count(*) FROM public.tasks t
    WHERE t.status NOT IN ('completed', 'approved', 'cancelled') GROUP BY t.department_id;
$$;
REVOKE ALL ON FUNCTION public.task_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_stats() TO authenticated, service_role;

-- A task reaches a client through its project, else through its campaign (the same rule the client hub always used).
-- open = not done and not cancelled; done = completed / approved; late = open with a due date before p_today (default: the studio date).
-- projects = the client's projects that are not completed or cancelled.
CREATE OR REPLACE FUNCTION public.client_task_stats(p_today DATE DEFAULT NULL)
RETURNS TABLE (client_id UUID, open_count BIGINT, done_count BIGINT, late_count BIGINT, project_count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  WITH tc AS (
    SELECT coalesce(pr.client_id, ca.client_id) AS cid,
           count(*) FILTER (WHERE t.status IN ('completed', 'approved')) AS done_n,
           count(*) FILTER (WHERE t.status NOT IN ('completed', 'approved', 'cancelled')) AS open_n,
           count(*) FILTER (WHERE t.status NOT IN ('completed', 'approved', 'cancelled') AND t.due_date IS NOT NULL
                              AND t.due_date < coalesce(p_today, public.studio_today())) AS late_n
    FROM public.tasks t
    LEFT JOIN public.projects pr ON pr.id = t.project_id
    LEFT JOIN public.campaigns ca ON ca.id = t.campaign_id
    WHERE coalesce(pr.client_id, ca.client_id) IS NOT NULL
    GROUP BY 1),
  pc AS (
    SELECT p.client_id AS cid, count(*) AS n FROM public.projects p
    WHERE p.client_id IS NOT NULL AND p.status NOT IN ('completed', 'cancelled') GROUP BY 1)
  SELECT coalesce(tc.cid, pc.cid), coalesce(tc.open_n, 0), coalesce(tc.done_n, 0), coalesce(tc.late_n, 0), coalesce(pc.n, 0)
  FROM tc FULL JOIN pc ON pc.cid = tc.cid;
$$;
REVOKE ALL ON FUNCTION public.client_task_stats(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_task_stats(DATE) TO authenticated, service_role;
