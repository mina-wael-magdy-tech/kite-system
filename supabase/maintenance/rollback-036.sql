-- KITE SYSTEM — rollback of migration 036 (Phase 6). Restores every original policy, then drops what 036 added.
-- Run as the database operator, e.g. psql -f supabase/maintenance/rollback-036.sql. No business data is touched.
BEGIN;
ALTER POLICY "assets_delete" ON public.assets USING ((auth_is_staff() AND
CASE
    WHEN finance_confidential THEN auth_is_finance()
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = auth.uid()) OR auth_is_owner() OR (auth_is_admin() AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = auth.uid()) OR auth_is_admin())
END));
ALTER POLICY "assets_insert" ON public.assets WITH CHECK ((auth_is_staff() AND (uploaded_by = auth.uid()) AND ((NOT finance_confidential) OR auth_is_finance()) AND ((client_id IS NULL) OR auth_can_see_client(client_id))));
ALTER POLICY "assets_select" ON public.assets USING ((auth_is_staff() AND
CASE
    WHEN finance_confidential THEN auth_is_finance()
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = auth.uid()) OR auth_is_owner() OR (auth_can_see_client(client_id) AND ((visibility = 'studio'::text) OR auth_is_admin() OR ((visibility = 'department'::text) AND (EXISTS ( SELECT 1
       FROM user_departments ud
      WHERE ((ud.user_id = auth.uid()) AND (ud.department_id = assets.department_id))))))))
    ELSE ((visibility = 'studio'::text) OR (uploaded_by = auth.uid()) OR auth_is_admin() OR ((visibility = 'department'::text) AND (EXISTS ( SELECT 1
       FROM user_departments ud
      WHERE ((ud.user_id = auth.uid()) AND (ud.department_id = assets.department_id))))))
END));
ALTER POLICY "assets_update" ON public.assets USING ((auth_is_staff() AND
CASE
    WHEN finance_confidential THEN auth_is_finance()
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = auth.uid()) OR auth_is_owner() OR (auth_is_admin() AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = auth.uid()) OR auth_is_admin() OR auth_is_finance())
END)) WITH CHECK ((auth_is_staff() AND
CASE
    WHEN finance_confidential THEN auth_is_finance()
    WHEN (client_id IS NOT NULL) THEN ((uploaded_by = auth.uid()) OR auth_is_owner() OR (auth_is_admin() AND auth_can_see_client(client_id)))
    ELSE ((uploaded_by = auth.uid()) OR auth_is_admin() OR auth_is_finance())
END));
ALTER POLICY "attendance_insert" ON public.attendance_records WITH CHECK (((user_id = auth.uid()) AND auth_is_staff()));
ALTER POLICY "attendance_select" ON public.attendance_records USING ((auth_is_admin() OR auth_has_role('hr_manager'::text) OR (user_id = auth.uid())));
ALTER POLICY "attendance_update" ON public.attendance_records USING ((auth_is_admin() OR auth_has_role('hr_manager'::text) OR ((user_id = auth.uid()) AND auth_is_staff()))) WITH CHECK ((auth_is_admin() OR auth_has_role('hr_manager'::text) OR ((user_id = auth.uid()) AND auth_is_staff())));
ALTER POLICY "audit_logs_select" ON public.audit_logs USING (
CASE
    WHEN ((action ~~ 'EXPENSE\_%'::text) OR (entity_type = ANY (ARRAY['expenses'::text, 'expense_approvals'::text, 'invoices'::text, 'invoice_items'::text, 'invoice_payments'::text, 'budgets'::text, 'vendors'::text, 'retainer_plans'::text, 'client_billing'::text, 'finance_settings'::text, 'money_figures'::text]))) THEN auth_is_finance()
    ELSE auth_is_admin()
END);
ALTER POLICY "broadcasts_select" ON public.broadcasts USING (auth_is_admin());
ALTER POLICY "budgets_delete" ON public.budgets USING (auth_is_owner());
ALTER POLICY "budgets_insert" ON public.budgets WITH CHECK (auth_is_owner());
ALTER POLICY "budgets_select" ON public.budgets USING (auth_is_owner());
ALTER POLICY "budgets_select_finance" ON public.budgets USING (auth_is_finance());
ALTER POLICY "budgets_update" ON public.budgets USING (auth_is_owner()) WITH CHECK (auth_is_owner());
ALTER POLICY "campaign_departments_delete" ON public.campaign_departments USING (auth_is_manager());
ALTER POLICY "campaign_departments_insert" ON public.campaign_departments WITH CHECK (auth_is_manager());
ALTER POLICY "campaign_departments_select" ON public.campaign_departments USING (auth_is_staff());
ALTER POLICY "campaign_members_delete" ON public.campaign_members USING (auth_is_manager());
ALTER POLICY "campaign_members_insert" ON public.campaign_members WITH CHECK (auth_is_manager());
ALTER POLICY "campaign_members_select" ON public.campaign_members USING (auth_is_staff());
ALTER POLICY "campaigns_delete" ON public.campaigns USING (auth_is_admin());
ALTER POLICY "campaigns_insert" ON public.campaigns WITH CHECK ((auth_is_manager() AND ((created_by IS NULL) OR (created_by = auth.uid()))));
ALTER POLICY "campaigns_select" ON public.campaigns USING (auth_is_staff());
ALTER POLICY "campaigns_update" ON public.campaigns USING ((auth_is_admin() OR (manager_id = auth.uid()) OR (created_by = auth.uid()))) WITH CHECK ((auth_is_admin() OR (manager_id = auth.uid()) OR (created_by = auth.uid())));
ALTER POLICY "client_activities_delete" ON public.client_activities USING (auth_is_manager());
ALTER POLICY "client_activities_insert" ON public.client_activities WITH CHECK (auth_is_manager());
ALTER POLICY "client_activities_select" ON public.client_activities USING (auth_is_manager());
ALTER POLICY "client_activities_update" ON public.client_activities USING (auth_is_manager()) WITH CHECK (auth_is_manager());
ALTER POLICY "client_billing_select" ON public.client_billing USING (auth_is_finance());
ALTER POLICY "client_contacts_delete" ON public.client_contacts USING (auth_is_manager());
ALTER POLICY "client_contacts_insert" ON public.client_contacts WITH CHECK (auth_is_manager());
ALTER POLICY "client_contacts_select" ON public.client_contacts USING ((auth_is_manager() AND auth_can_see_client(client_id)));
ALTER POLICY "client_contacts_update" ON public.client_contacts USING (auth_is_manager()) WITH CHECK (auth_is_manager());
ALTER POLICY "client_departments_delete" ON public.client_departments USING (auth_is_manager());
ALTER POLICY "client_departments_insert" ON public.client_departments WITH CHECK (auth_is_manager());
ALTER POLICY "clients_delete" ON public.clients USING (auth_is_admin());
ALTER POLICY "clients_insert" ON public.clients WITH CHECK ((auth_is_manager() AND ((created_by IS NULL) OR (created_by = auth.uid()))));
ALTER POLICY "clients_update" ON public.clients USING ((auth_is_manager() AND auth_can_see_client(id))) WITH CHECK (auth_is_manager());
ALTER POLICY "company_settings_insert" ON public.company_settings WITH CHECK (auth_is_admin());
ALTER POLICY "company_settings_select" ON public.company_settings USING (auth_is_staff());
ALTER POLICY "company_settings_update" ON public.company_settings USING (auth_is_admin()) WITH CHECK (auth_is_admin());
ALTER POLICY "feedback_select" ON public.content_feedback USING (auth_is_staff());
ALTER POLICY "plans_insert" ON public.content_plans WITH CHECK ((auth_is_staff() AND (created_by = auth.uid())));
ALTER POLICY "plans_select" ON public.content_plans USING (auth_is_staff());
ALTER POLICY "plan_assets_insert" ON public.content_post_assets WITH CHECK ((auth_can_edit_plan(plan_id) AND (uploaded_by = auth.uid()) AND ((post_id IS NULL) OR (EXISTS ( SELECT 1
   FROM content_posts p
  WHERE ((p.id = content_post_assets.post_id) AND (p.plan_id = content_post_assets.plan_id)))))));
ALTER POLICY "plan_assets_select" ON public.content_post_assets USING (auth_is_staff());
ALTER POLICY "posts_select" ON public.content_posts USING (auth_is_staff());
ALTER POLICY "posts_update" ON public.content_posts USING ((auth_can_edit_plan(plan_id) OR ((publisher_id = auth.uid()) AND auth_is_staff()))) WITH CHECK ((auth_can_edit_plan(plan_id) OR ((publisher_id = auth.uid()) AND auth_is_staff())));
ALTER POLICY "deleted_users_select" ON public.deleted_users USING (auth_is_admin());
ALTER POLICY "departments_delete" ON public.departments USING (auth_is_admin());
ALTER POLICY "departments_insert" ON public.departments WITH CHECK (auth_is_admin());
ALTER POLICY "departments_select" ON public.departments USING (auth_is_staff());
ALTER POLICY "departments_update" ON public.departments USING (auth_is_admin()) WITH CHECK (auth_is_admin());
ALTER POLICY "employee_documents_delete" ON public.employee_documents USING ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "employee_documents_insert" ON public.employee_documents WITH CHECK (((auth_is_admin() OR auth_has_role('hr_manager'::text)) AND (uploaded_by = auth.uid())));
ALTER POLICY "employee_documents_select" ON public.employee_documents USING ((auth_is_admin() OR auth_has_role('hr_manager'::text) OR (user_id = auth.uid())));
ALTER POLICY "expense_approvals_select" ON public.expense_approvals USING (auth_is_finance());
ALTER POLICY "expenses_insert" ON public.expenses WITH CHECK ((auth_is_staff() AND (submitted_by = auth.uid()) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text]))));
ALTER POLICY "expenses_select" ON public.expenses USING (auth_is_finance());
ALTER POLICY "expenses_select_finance" ON public.expenses USING (auth_is_finance());
ALTER POLICY "finance_audit_log_select" ON public.finance_audit_log USING (auth_is_finance());
ALTER POLICY "finance_settings_select" ON public.finance_settings USING (auth_is_finance());
ALTER POLICY "holidays_delete" ON public.holidays USING ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "holidays_insert" ON public.holidays WITH CHECK ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "holidays_select" ON public.holidays USING (auth_is_staff());
ALTER POLICY "holidays_update" ON public.holidays USING ((auth_is_admin() OR auth_has_role('hr_manager'::text))) WITH CHECK ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "invitations_select" ON public.invitations USING ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "invoice_items_select" ON public.invoice_items USING (auth_is_finance());
ALTER POLICY "invoice_number_seq_select" ON public.invoice_number_seq USING (auth_is_finance());
ALTER POLICY "invoice_payments_select" ON public.invoice_payments USING (auth_is_finance());
ALTER POLICY "invoices_select" ON public.invoices USING (auth_is_finance());
ALTER POLICY "lead_stage_history_select" ON public.lead_stage_history USING ((auth_is_admin() OR (EXISTS ( SELECT 1
   FROM leads l
  WHERE (l.id = lead_stage_history.lead_id)))));
ALTER POLICY "leads_delete" ON public.leads USING (auth_is_admin());
ALTER POLICY "leads_insert" ON public.leads WITH CHECK ((auth_is_manager() AND ((created_by IS NULL) OR (created_by = auth.uid()))));
ALTER POLICY "leads_select" ON public.leads USING ((auth_is_manager() OR (assigned_to = auth.uid()) OR (created_by = auth.uid())));
ALTER POLICY "leads_update" ON public.leads USING ((auth_is_manager() OR (assigned_to = auth.uid()))) WITH CHECK ((auth_is_manager() OR (assigned_to = auth.uid())));
ALTER POLICY "leave_requests_insert" ON public.leave_requests WITH CHECK (((user_id = auth.uid()) AND auth_is_staff() AND (status = 'pending'::text) AND (reviewed_by IS NULL)));
ALTER POLICY "leave_requests_select" ON public.leave_requests USING ((auth_is_admin() OR auth_has_role('hr_manager'::text) OR (user_id = auth.uid())));
ALTER POLICY "leave_types_delete" ON public.leave_types USING ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "leave_types_insert" ON public.leave_types WITH CHECK ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "leave_types_select" ON public.leave_types USING (auth_is_staff());
ALTER POLICY "leave_types_update" ON public.leave_types USING ((auth_is_admin() OR auth_has_role('hr_manager'::text))) WITH CHECK ((auth_is_admin() OR auth_has_role('hr_manager'::text)));
ALTER POLICY "messages_insert" ON public.messages WITH CHECK (((sender_id = auth.uid()) AND (message_type = ANY (ARRAY['text'::text, 'task_handoff'::text, 'voice'::text, 'image'::text, 'file'::text, 'call'::text])) AND auth_can_post_conversation(conversation_id)));
ALTER POLICY "milestones_delete" ON public.milestones USING ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "milestones_insert" ON public.milestones WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "milestones_update" ON public.milestones USING ((auth_is_admin() OR auth_is_project_manager(project_id))) WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "money_figures_all" ON public.money_figures USING (auth_is_owner()) WITH CHECK ((auth_is_owner() AND (NOT (updated_by IS DISTINCT FROM auth.uid()))));
ALTER POLICY "notification_preferences_insert" ON public.notification_preferences WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "notification_preferences_select" ON public.notification_preferences USING ((user_id = auth.uid()));
ALTER POLICY "notification_preferences_update" ON public.notification_preferences USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "notifications_select" ON public.notifications USING ((user_id = auth.uid()));
ALTER POLICY "notifications_update" ON public.notifications USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "opportunities_delete" ON public.opportunities USING (auth_is_manager());
ALTER POLICY "opportunities_insert" ON public.opportunities WITH CHECK (auth_is_manager());
ALTER POLICY "opportunities_select" ON public.opportunities USING (auth_is_manager());
ALTER POLICY "opportunities_update" ON public.opportunities USING (auth_is_manager()) WITH CHECK (auth_is_manager());
ALTER POLICY "permissions_select" ON public.permissions USING (auth_is_staff());
ALTER POLICY "profiles_select" ON public.profiles USING (((id = auth.uid()) OR auth_is_staff()));
ALTER POLICY "profiles_update_self" ON public.profiles USING (((id = auth.uid()) AND auth_is_active())) WITH CHECK ((id = auth.uid()));
ALTER POLICY "project_departments_delete" ON public.project_departments USING ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "project_departments_insert" ON public.project_departments WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "project_departments_update" ON public.project_departments USING ((auth_is_admin() OR auth_is_project_manager(project_id))) WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_delete" ON public.project_members USING ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_insert" ON public.project_members WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "project_members_update" ON public.project_members USING ((auth_is_admin() OR auth_is_project_manager(project_id))) WITH CHECK ((auth_is_admin() OR auth_is_project_manager(project_id)));
ALTER POLICY "projects_delete" ON public.projects USING (auth_is_admin());
ALTER POLICY "projects_insert" ON public.projects WITH CHECK ((auth_is_manager() AND ((created_by IS NULL) OR (created_by = auth.uid()))));
ALTER POLICY "projects_update" ON public.projects USING ((auth_is_admin() OR (project_manager_id = auth.uid()) OR (created_by = auth.uid()))) WITH CHECK ((auth_is_admin() OR (project_manager_id = auth.uid()) OR (created_by = auth.uid())));
ALTER POLICY "push_subscriptions_select" ON public.push_subscriptions USING ((user_id = auth.uid()));
ALTER POLICY "retainer_plans_select" ON public.retainer_plans USING (auth_is_finance());
ALTER POLICY "role_permissions_select" ON public.role_permissions USING (auth_is_staff());
ALTER POLICY "roles_select" ON public.roles USING (auth_is_staff());
ALTER POLICY "task_activity_logs_select" ON public.task_activity_logs USING (auth_can_view_task(task_id));
ALTER POLICY "task_assignees_select" ON public.task_assignees USING (auth_can_view_task(task_id));
ALTER POLICY "task_attachments_delete" ON public.task_attachments USING (((uploaded_by = auth.uid()) OR auth_is_admin()));
ALTER POLICY "task_attachments_insert" ON public.task_attachments WITH CHECK (((uploaded_by = auth.uid()) AND auth_can_view_task(task_id)));
ALTER POLICY "task_attachments_select" ON public.task_attachments USING (auth_can_view_task(task_id));
ALTER POLICY "task_checklists_delete" ON public.task_checklists USING (auth_can_view_task(task_id));
ALTER POLICY "task_checklists_insert" ON public.task_checklists WITH CHECK (auth_can_view_task(task_id));
ALTER POLICY "task_checklists_select" ON public.task_checklists USING (auth_can_view_task(task_id));
ALTER POLICY "task_checklists_update" ON public.task_checklists USING (auth_can_view_task(task_id)) WITH CHECK (auth_can_view_task(task_id));
ALTER POLICY "task_comments_insert" ON public.task_comments WITH CHECK (((user_id = auth.uid()) AND (is_system_message = false) AND auth_can_view_task(task_id)));
ALTER POLICY "task_comments_select" ON public.task_comments USING (auth_can_view_task(task_id));
ALTER POLICY "task_handoffs_select" ON public.task_handoffs USING (auth_can_view_task(task_id));
ALTER POLICY "task_links_delete" ON public.task_links USING (((added_by = auth.uid()) OR auth_is_admin()));
ALTER POLICY "task_links_insert" ON public.task_links WITH CHECK (((added_by = auth.uid()) AND auth_can_view_task(task_id)));
ALTER POLICY "task_links_select" ON public.task_links USING (auth_can_view_task(task_id));
ALTER POLICY "task_time_entries_delete" ON public.task_time_entries USING ((user_id = auth.uid()));
ALTER POLICY "task_time_entries_insert" ON public.task_time_entries WITH CHECK (((user_id = auth.uid()) AND auth_can_view_task(task_id)));
ALTER POLICY "task_time_entries_select" ON public.task_time_entries USING (((user_id = auth.uid()) OR auth_can_view_task(task_id)));
ALTER POLICY "task_time_entries_update" ON public.task_time_entries USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
ALTER POLICY "tasks_select" ON public.tasks USING (auth_can_view_task(id));
ALTER POLICY "teams_delete" ON public.teams USING ((auth_is_admin() OR auth_is_dept_manager(department_id)));
ALTER POLICY "teams_insert" ON public.teams WITH CHECK ((auth_is_admin() OR auth_is_dept_manager(department_id)));
ALTER POLICY "teams_select" ON public.teams USING (auth_is_staff());
ALTER POLICY "teams_update" ON public.teams USING ((auth_is_admin() OR auth_is_dept_manager(department_id))) WITH CHECK ((auth_is_admin() OR auth_is_dept_manager(department_id)));
ALTER POLICY "user_departments_select" ON public.user_departments USING (((user_id = auth.uid()) OR auth_is_staff()));
ALTER POLICY "user_roles_select" ON public.user_roles USING (((user_id = auth.uid()) OR auth_is_staff()));
ALTER POLICY "vendors_delete" ON public.vendors USING (auth_is_owner());
ALTER POLICY "vendors_insert" ON public.vendors WITH CHECK (auth_is_owner());
ALTER POLICY "vendors_select" ON public.vendors USING (auth_is_owner());
ALTER POLICY "vendors_select_finance" ON public.vendors USING (auth_is_finance());
ALTER POLICY "vendors_update" ON public.vendors USING (auth_is_owner()) WITH CHECK (auth_is_owner());
DROP FUNCTION IF EXISTS public.task_stats();
DROP FUNCTION IF EXISTS public.client_task_stats(DATE);
DROP INDEX IF EXISTS public.idx_tasks_created_desc, public.idx_invoices_created_desc, public.idx_expenses_created_desc,
  public.idx_task_attachments_created_desc, public.idx_assets_created_desc, public.idx_leads_created_desc;
-- the helpers are dropped last: the restored policies no longer use them
DROP FUNCTION IF EXISTS public.auth_managed_department_ids(), public.auth_assigned_task_ids(), public.auth_managed_project_ids();
COMMIT;
