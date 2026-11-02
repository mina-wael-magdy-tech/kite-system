-- ====================================================================
-- PULSE STUDIO OS — 002_rls_policies.sql
-- ACCESS CONTROL ONLY: privileges, helper predicates, Row Level Security.
--
-- No business logic lives in the database. Workflow side-effects
-- (activity logs, notifications, approvals, audit) are performed by the
-- `workflow` Edge Function using the service role.
--
-- Model: default-deny.
--   * `anon` has no privileges at all.
--   * `authenticated` gets only the privileges granted below, then RLS
--     narrows the rows. Every predicate requires an ACTIVE profile, so
--     suspended / onboarding users and strangers holding a valid JWT see
--     nothing.
--   * The 'client' role is NOT staff: it can read only its own profile.
-- ====================================================================

-- 1. Enable RLS on every application table
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 2. Reset privileges: nothing for anon, nothing implicit for authenticated
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- ====================================================================
-- 3. ACCESS-CONTROL PREDICATES
--    SECURITY DEFINER so policies can consult membership tables without RLS
--    recursion. search_path is pinned to '' (all references schema-qualified).
-- ====================================================================

CREATE OR REPLACE FUNCTION public.auth_is_active()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.employment_status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_has_role(p_role_name TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid() AND r.name = p_role_name AND r.is_active = true
  );
$$;

-- Internal staff = active profile holding at least one role other than 'client'
CREATE OR REPLACE FUNCTION public.auth_is_staff()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid() AND r.name <> 'client' AND r.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('super_admin', 'owner', 'general_manager')
      AND r.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_is_manager()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()
      AND r.name IN ('super_admin', 'owner', 'general_manager',
                     'department_manager', 'project_manager', 'team_leader')
      AND r.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_is_dept_manager(p_dept_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_dept_id IS NOT NULL AND public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.departments d
    WHERE d.id = p_dept_id AND d.manager_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_is_project_manager(p_project_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_active() AND EXISTS (
    SELECT 1 FROM public.projects pr
    WHERE pr.id = p_project_id AND pr.project_manager_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_can_view_project(p_project_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.projects pr
    WHERE pr.id = p_project_id AND (
      public.auth_is_admin()
      OR pr.project_manager_id = auth.uid()
      OR pr.created_by = auth.uid()
      OR EXISTS (SELECT 1 FROM public.project_members pm
                 WHERE pm.project_id = pr.id AND pm.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.project_departments pd
                 JOIN public.user_departments ud ON ud.department_id = pd.department_id
                 WHERE pd.project_id = pr.id AND ud.user_id = auth.uid())
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_can_view_task(p_task_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id = p_task_id AND (
      public.auth_is_admin()
      OR t.assigned_to = auth.uid()
      OR t.created_by = auth.uid()
      OR public.auth_is_dept_manager(t.department_id)
      OR EXISTS (SELECT 1 FROM public.task_assignees ta
                 WHERE ta.task_id = t.id AND ta.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.projects pr
                 WHERE pr.id = t.project_id AND pr.project_manager_id = auth.uid())
    )
  );
$$;

-- Open channels (is_public) are visible to all staff; all others need membership.
CREATE OR REPLACE FUNCTION public.auth_can_view_conversation(p_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND (
      c.is_public
      OR public.auth_is_admin()
      OR EXISTS (SELECT 1 FROM public.conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid())
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.auth_can_post_conversation(p_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.is_archived = false AND (
      c.is_public
      OR EXISTS (SELECT 1 FROM public.conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid())
    )
  );
$$;

-- Predicates: callable by signed-in users (policies need them) and the service role only.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'auth\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $$;

-- ====================================================================
-- 4. TABLE PRIVILEGES (what `authenticated` may even attempt)
-- ====================================================================

GRANT SELECT, INSERT ON public.attendance_records TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budgets TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.campaign_departments TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.campaign_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.company_settings TO authenticated;
GRANT SELECT ON public.conversation_members TO authenticated;
GRANT SELECT ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.departments TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.employee_documents TO authenticated;
GRANT SELECT ON public.expense_approvals TO authenticated;
GRANT SELECT, INSERT ON public.expenses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.holidays TO authenticated;
GRANT SELECT ON public.invitations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT SELECT, INSERT ON public.leave_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leave_types TO authenticated;
GRANT SELECT ON public.message_attachments TO authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.milestones TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.opportunities TO authenticated;
GRANT SELECT ON public.permissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_departments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT ON public.role_permissions TO authenticated;
GRANT SELECT ON public.roles TO authenticated;
GRANT SELECT ON public.task_activity_logs TO authenticated;
GRANT SELECT ON public.task_assignees TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.task_attachments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_checklist_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_checklists TO authenticated;
GRANT SELECT, INSERT ON public.task_comments TO authenticated;
GRANT SELECT ON public.task_handoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_time_entries TO authenticated;
GRANT SELECT ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams TO authenticated;
GRANT SELECT ON public.user_departments TO authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendors TO authenticated;

-- Column-level privileges. Users may edit only these columns of their own rows;
-- identity, role, status and privilege columns change only via Edge Functions.
-- (emergency_contact_* are write-only for users; HR reads them with the service role.)
GRANT SELECT (id, employee_id, full_name, email, phone, avatar_url, job_title, department_id,
              bio, skills, employment_status, employment_type, joining_date, location,
              manager_id, created_at, updated_at)
  ON public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, avatar_url, bio, skills, location,
              emergency_contact_name, emergency_contact_phone)
  ON public.profiles TO authenticated;

GRANT UPDATE (check_out, total_hours, notes) ON public.attendance_records TO authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;

-- The service role (Edge Functions) keeps full access.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ====================================================================
-- 5. ROW LEVEL SECURITY POLICIES
-- ====================================================================

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.auth_is_staff());

DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
CREATE POLICY "profiles_update_self" ON public.profiles FOR UPDATE TO authenticated
    USING (id = auth.uid() AND public.auth_is_active())
    WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "departments_select" ON public.departments;
CREATE POLICY "departments_select" ON public.departments FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "departments_insert" ON public.departments;
CREATE POLICY "departments_insert" ON public.departments FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS "departments_update" ON public.departments;
CREATE POLICY "departments_update" ON public.departments FOR UPDATE TO authenticated
    USING (public.auth_is_admin())
    WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS "departments_delete" ON public.departments;
CREATE POLICY "departments_delete" ON public.departments FOR DELETE TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "teams_select" ON public.teams;
CREATE POLICY "teams_select" ON public.teams FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "teams_insert" ON public.teams;
CREATE POLICY "teams_insert" ON public.teams FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin() OR public.auth_is_dept_manager(department_id));

DROP POLICY IF EXISTS "teams_update" ON public.teams;
CREATE POLICY "teams_update" ON public.teams FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_dept_manager(department_id))
    WITH CHECK (public.auth_is_admin() OR public.auth_is_dept_manager(department_id));

DROP POLICY IF EXISTS "teams_delete" ON public.teams;
CREATE POLICY "teams_delete" ON public.teams FOR DELETE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_dept_manager(department_id));

DROP POLICY IF EXISTS "roles_select" ON public.roles;
CREATE POLICY "roles_select" ON public.roles FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "permissions_select" ON public.permissions;
CREATE POLICY "permissions_select" ON public.permissions FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "role_permissions_select" ON public.role_permissions;
CREATE POLICY "role_permissions_select" ON public.role_permissions FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "user_roles_select" ON public.user_roles;
CREATE POLICY "user_roles_select" ON public.user_roles FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.auth_is_staff());

DROP POLICY IF EXISTS "user_departments_select" ON public.user_departments;
CREATE POLICY "user_departments_select" ON public.user_departments FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.auth_is_staff());

DROP POLICY IF EXISTS "invitations_select" ON public.invitations;
CREATE POLICY "invitations_select" ON public.invitations FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select" ON public.clients FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "clients_insert" ON public.clients;
CREATE POLICY "clients_insert" ON public.clients FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager() AND (created_by IS NULL OR created_by = auth.uid()));

DROP POLICY IF EXISTS "clients_update" ON public.clients;
CREATE POLICY "clients_update" ON public.clients FOR UPDATE TO authenticated
    USING (public.auth_is_manager())
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "clients_delete" ON public.clients;
CREATE POLICY "clients_delete" ON public.clients FOR DELETE TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "client_contacts_select" ON public.client_contacts;
CREATE POLICY "client_contacts_select" ON public.client_contacts FOR SELECT TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "client_contacts_insert" ON public.client_contacts;
CREATE POLICY "client_contacts_insert" ON public.client_contacts FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "client_contacts_update" ON public.client_contacts;
CREATE POLICY "client_contacts_update" ON public.client_contacts FOR UPDATE TO authenticated
    USING (public.auth_is_manager())
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "client_contacts_delete" ON public.client_contacts;
CREATE POLICY "client_contacts_delete" ON public.client_contacts FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "opportunities_select" ON public.opportunities;
CREATE POLICY "opportunities_select" ON public.opportunities FOR SELECT TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "opportunities_insert" ON public.opportunities;
CREATE POLICY "opportunities_insert" ON public.opportunities FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "opportunities_update" ON public.opportunities;
CREATE POLICY "opportunities_update" ON public.opportunities FOR UPDATE TO authenticated
    USING (public.auth_is_manager())
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "opportunities_delete" ON public.opportunities;
CREATE POLICY "opportunities_delete" ON public.opportunities FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "client_activities_select" ON public.client_activities;
CREATE POLICY "client_activities_select" ON public.client_activities FOR SELECT TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "client_activities_insert" ON public.client_activities;
CREATE POLICY "client_activities_insert" ON public.client_activities FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "client_activities_update" ON public.client_activities;
CREATE POLICY "client_activities_update" ON public.client_activities FOR UPDATE TO authenticated
    USING (public.auth_is_manager())
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "client_activities_delete" ON public.client_activities;
CREATE POLICY "client_activities_delete" ON public.client_activities FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "leads_select" ON public.leads;
CREATE POLICY "leads_select" ON public.leads FOR SELECT TO authenticated
    USING (public.auth_is_manager() OR assigned_to = auth.uid() OR created_by = auth.uid());

DROP POLICY IF EXISTS "leads_insert" ON public.leads;
CREATE POLICY "leads_insert" ON public.leads FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager() AND (created_by IS NULL OR created_by = auth.uid()));

DROP POLICY IF EXISTS "leads_update" ON public.leads;
CREATE POLICY "leads_update" ON public.leads FOR UPDATE TO authenticated
    USING (public.auth_is_manager() OR assigned_to = auth.uid())
    WITH CHECK (public.auth_is_manager() OR assigned_to = auth.uid());

DROP POLICY IF EXISTS "leads_delete" ON public.leads;
CREATE POLICY "leads_delete" ON public.leads FOR DELETE TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "campaigns_select" ON public.campaigns;
CREATE POLICY "campaigns_select" ON public.campaigns FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "campaigns_insert" ON public.campaigns;
CREATE POLICY "campaigns_insert" ON public.campaigns FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager() AND (created_by IS NULL OR created_by = auth.uid()));

DROP POLICY IF EXISTS "campaigns_update" ON public.campaigns;
CREATE POLICY "campaigns_update" ON public.campaigns FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR manager_id = auth.uid() OR created_by = auth.uid())
    WITH CHECK (public.auth_is_admin() OR manager_id = auth.uid() OR created_by = auth.uid());

DROP POLICY IF EXISTS "campaigns_delete" ON public.campaigns;
CREATE POLICY "campaigns_delete" ON public.campaigns FOR DELETE TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "campaign_members_select" ON public.campaign_members;
CREATE POLICY "campaign_members_select" ON public.campaign_members FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "campaign_members_insert" ON public.campaign_members;
CREATE POLICY "campaign_members_insert" ON public.campaign_members FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "campaign_members_delete" ON public.campaign_members;
CREATE POLICY "campaign_members_delete" ON public.campaign_members FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "campaign_departments_select" ON public.campaign_departments;
CREATE POLICY "campaign_departments_select" ON public.campaign_departments FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "campaign_departments_insert" ON public.campaign_departments;
CREATE POLICY "campaign_departments_insert" ON public.campaign_departments FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager());

DROP POLICY IF EXISTS "campaign_departments_delete" ON public.campaign_departments;
CREATE POLICY "campaign_departments_delete" ON public.campaign_departments FOR DELETE TO authenticated
    USING (public.auth_is_manager());

DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT TO authenticated
    USING (public.auth_can_view_project(id));

DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_manager() AND (created_by IS NULL OR created_by = auth.uid()));

DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR project_manager_id = auth.uid() OR created_by = auth.uid())
    WITH CHECK (public.auth_is_admin() OR project_manager_id = auth.uid() OR created_by = auth.uid());

DROP POLICY IF EXISTS "projects_delete" ON public.projects;
CREATE POLICY "projects_delete" ON public.projects FOR DELETE TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
CREATE POLICY "project_members_select" ON public.project_members FOR SELECT TO authenticated
    USING (public.auth_can_view_project(project_id));

DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id))
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;
CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "project_departments_select" ON public.project_departments;
CREATE POLICY "project_departments_select" ON public.project_departments FOR SELECT TO authenticated
    USING (public.auth_can_view_project(project_id));

DROP POLICY IF EXISTS "project_departments_insert" ON public.project_departments;
CREATE POLICY "project_departments_insert" ON public.project_departments FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "project_departments_update" ON public.project_departments;
CREATE POLICY "project_departments_update" ON public.project_departments FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id))
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "project_departments_delete" ON public.project_departments;
CREATE POLICY "project_departments_delete" ON public.project_departments FOR DELETE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "milestones_select" ON public.milestones;
CREATE POLICY "milestones_select" ON public.milestones FOR SELECT TO authenticated
    USING (public.auth_can_view_project(project_id));

DROP POLICY IF EXISTS "milestones_insert" ON public.milestones;
CREATE POLICY "milestones_insert" ON public.milestones FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "milestones_update" ON public.milestones;
CREATE POLICY "milestones_update" ON public.milestones FOR UPDATE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id))
    WITH CHECK (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "milestones_delete" ON public.milestones;
CREATE POLICY "milestones_delete" ON public.milestones FOR DELETE TO authenticated
    USING (public.auth_is_admin() OR public.auth_is_project_manager(project_id));

DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT TO authenticated
    USING (public.auth_can_view_task(id));

DROP POLICY IF EXISTS "task_assignees_select" ON public.task_assignees;
CREATE POLICY "task_assignees_select" ON public.task_assignees FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_activity_logs_select" ON public.task_activity_logs;
CREATE POLICY "task_activity_logs_select" ON public.task_activity_logs FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_handoffs_select" ON public.task_handoffs;
CREATE POLICY "task_handoffs_select" ON public.task_handoffs FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_checklists_select" ON public.task_checklists;
CREATE POLICY "task_checklists_select" ON public.task_checklists FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_checklists_insert" ON public.task_checklists;
CREATE POLICY "task_checklists_insert" ON public.task_checklists FOR INSERT TO authenticated
    WITH CHECK (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_checklists_update" ON public.task_checklists;
CREATE POLICY "task_checklists_update" ON public.task_checklists FOR UPDATE TO authenticated
    USING (public.auth_can_view_task(task_id))
    WITH CHECK (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_checklists_delete" ON public.task_checklists;
CREATE POLICY "task_checklists_delete" ON public.task_checklists FOR DELETE TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_checklist_items_select" ON public.task_checklist_items;
CREATE POLICY "task_checklist_items_select" ON public.task_checklist_items FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.task_checklists c WHERE c.id = checklist_id));

DROP POLICY IF EXISTS "task_checklist_items_insert" ON public.task_checklist_items;
CREATE POLICY "task_checklist_items_insert" ON public.task_checklist_items FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.task_checklists c WHERE c.id = checklist_id));

DROP POLICY IF EXISTS "task_checklist_items_update" ON public.task_checklist_items;
CREATE POLICY "task_checklist_items_update" ON public.task_checklist_items FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.task_checklists c WHERE c.id = checklist_id))
    WITH CHECK (EXISTS (SELECT 1 FROM public.task_checklists c WHERE c.id = checklist_id));

DROP POLICY IF EXISTS "task_checklist_items_delete" ON public.task_checklist_items;
CREATE POLICY "task_checklist_items_delete" ON public.task_checklist_items FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.task_checklists c WHERE c.id = checklist_id));

DROP POLICY IF EXISTS "task_comments_select" ON public.task_comments;
CREATE POLICY "task_comments_select" ON public.task_comments FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_comments_insert" ON public.task_comments;
CREATE POLICY "task_comments_insert" ON public.task_comments FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND is_system_message = false AND public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_attachments_select" ON public.task_attachments;
CREATE POLICY "task_attachments_select" ON public.task_attachments FOR SELECT TO authenticated
    USING (public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_attachments_insert" ON public.task_attachments;
CREATE POLICY "task_attachments_insert" ON public.task_attachments FOR INSERT TO authenticated
    WITH CHECK (uploaded_by = auth.uid() AND public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_attachments_delete" ON public.task_attachments;
CREATE POLICY "task_attachments_delete" ON public.task_attachments FOR DELETE TO authenticated
    USING (uploaded_by = auth.uid() OR public.auth_is_admin());

DROP POLICY IF EXISTS "task_time_entries_select" ON public.task_time_entries;
CREATE POLICY "task_time_entries_select" ON public.task_time_entries FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_time_entries_insert" ON public.task_time_entries;
CREATE POLICY "task_time_entries_insert" ON public.task_time_entries FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND public.auth_can_view_task(task_id));

DROP POLICY IF EXISTS "task_time_entries_update" ON public.task_time_entries;
CREATE POLICY "task_time_entries_update" ON public.task_time_entries FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "task_time_entries_delete" ON public.task_time_entries;
CREATE POLICY "task_time_entries_delete" ON public.task_time_entries FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "attendance_select" ON public.attendance_records;
CREATE POLICY "attendance_select" ON public.attendance_records FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) OR user_id = auth.uid());

DROP POLICY IF EXISTS "attendance_insert" ON public.attendance_records;
CREATE POLICY "attendance_insert" ON public.attendance_records FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND public.auth_is_staff());

DROP POLICY IF EXISTS "attendance_update" ON public.attendance_records;
CREATE POLICY "attendance_update" ON public.attendance_records FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) OR (user_id = auth.uid() AND public.auth_is_staff()))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) OR (user_id = auth.uid() AND public.auth_is_staff()));

DROP POLICY IF EXISTS "leave_types_select" ON public.leave_types;
CREATE POLICY "leave_types_select" ON public.leave_types FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "leave_types_insert" ON public.leave_types;
CREATE POLICY "leave_types_insert" ON public.leave_types FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "leave_types_update" ON public.leave_types;
CREATE POLICY "leave_types_update" ON public.leave_types FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "leave_types_delete" ON public.leave_types;
CREATE POLICY "leave_types_delete" ON public.leave_types FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "holidays_select" ON public.holidays;
CREATE POLICY "holidays_select" ON public.holidays FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "holidays_insert" ON public.holidays;
CREATE POLICY "holidays_insert" ON public.holidays FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "holidays_update" ON public.holidays;
CREATE POLICY "holidays_update" ON public.holidays FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "holidays_delete" ON public.holidays;
CREATE POLICY "holidays_delete" ON public.holidays FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "leave_requests_select" ON public.leave_requests;
CREATE POLICY "leave_requests_select" ON public.leave_requests FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) OR user_id = auth.uid());

DROP POLICY IF EXISTS "leave_requests_insert" ON public.leave_requests;
CREATE POLICY "leave_requests_insert" ON public.leave_requests FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND public.auth_is_staff() AND status = 'pending' AND reviewed_by IS NULL);

DROP POLICY IF EXISTS "employee_documents_select" ON public.employee_documents;
CREATE POLICY "employee_documents_select" ON public.employee_documents FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) OR user_id = auth.uid());

DROP POLICY IF EXISTS "employee_documents_insert" ON public.employee_documents;
CREATE POLICY "employee_documents_insert" ON public.employee_documents FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('hr_manager')) AND uploaded_by = auth.uid());

DROP POLICY IF EXISTS "employee_documents_delete" ON public.employee_documents;
CREATE POLICY "employee_documents_delete" ON public.employee_documents FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('hr_manager')));

DROP POLICY IF EXISTS "budgets_select" ON public.budgets;
CREATE POLICY "budgets_select" ON public.budgets FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')) OR public.auth_is_dept_manager(department_id));

DROP POLICY IF EXISTS "budgets_insert" ON public.budgets;
CREATE POLICY "budgets_insert" ON public.budgets FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "budgets_update" ON public.budgets;
CREATE POLICY "budgets_update" ON public.budgets FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "budgets_delete" ON public.budgets;
CREATE POLICY "budgets_delete" ON public.budgets FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "vendors_select" ON public.vendors;
CREATE POLICY "vendors_select" ON public.vendors FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "vendors_insert" ON public.vendors;
CREATE POLICY "vendors_insert" ON public.vendors FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "vendors_update" ON public.vendors;
CREATE POLICY "vendors_update" ON public.vendors FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "vendors_delete" ON public.vendors;
CREATE POLICY "vendors_delete" ON public.vendors FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "invoices_insert" ON public.invoices;
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT TO authenticated
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "invoices_update" ON public.invoices;
CREATE POLICY "invoices_update" ON public.invoices FOR UPDATE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')))
    WITH CHECK ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "invoices_delete" ON public.invoices;
CREATE POLICY "invoices_delete" ON public.invoices FOR DELETE TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')));

DROP POLICY IF EXISTS "expenses_select" ON public.expenses;
CREATE POLICY "expenses_select" ON public.expenses FOR SELECT TO authenticated
    USING (public.auth_is_staff() AND ((public.auth_is_admin() OR public.auth_has_role('finance_manager')) OR submitted_by = auth.uid() OR public.auth_is_dept_manager(department_id)));

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
CREATE POLICY "expenses_insert" ON public.expenses FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_staff() AND submitted_by = auth.uid() AND status IN ('draft','submitted'));

DROP POLICY IF EXISTS "expense_approvals_select" ON public.expense_approvals;
CREATE POLICY "expense_approvals_select" ON public.expense_approvals FOR SELECT TO authenticated
    USING ((public.auth_is_admin() OR public.auth_has_role('finance_manager')) OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
CREATE POLICY "conversations_select" ON public.conversations FOR SELECT TO authenticated
    USING (public.auth_can_view_conversation(id));

DROP POLICY IF EXISTS "conversation_members_select" ON public.conversation_members;
CREATE POLICY "conversation_members_select" ON public.conversation_members FOR SELECT TO authenticated
    USING (public.auth_can_view_conversation(conversation_id));

DROP POLICY IF EXISTS "messages_select" ON public.messages;
CREATE POLICY "messages_select" ON public.messages FOR SELECT TO authenticated
    USING (public.auth_can_view_conversation(conversation_id));

DROP POLICY IF EXISTS "messages_insert" ON public.messages;
CREATE POLICY "messages_insert" ON public.messages FOR INSERT TO authenticated
    WITH CHECK (sender_id = auth.uid() AND message_type IN ('text','task_handoff') AND public.auth_can_post_conversation(conversation_id));

DROP POLICY IF EXISTS "message_attachments_select" ON public.message_attachments;
CREATE POLICY "message_attachments_select" ON public.message_attachments FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_id));

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_update" ON public.notifications;
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "notification_preferences_select" ON public.notification_preferences;
CREATE POLICY "notification_preferences_select" ON public.notification_preferences FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notification_preferences_insert" ON public.notification_preferences;
CREATE POLICY "notification_preferences_insert" ON public.notification_preferences FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "notification_preferences_update" ON public.notification_preferences;
CREATE POLICY "notification_preferences_update" ON public.notification_preferences FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
CREATE POLICY "audit_logs_select" ON public.audit_logs FOR SELECT TO authenticated
    USING (public.auth_is_admin());

DROP POLICY IF EXISTS "company_settings_select" ON public.company_settings;
CREATE POLICY "company_settings_select" ON public.company_settings FOR SELECT TO authenticated
    USING (public.auth_is_staff());

DROP POLICY IF EXISTS "company_settings_insert" ON public.company_settings;
CREATE POLICY "company_settings_insert" ON public.company_settings FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_admin());

DROP POLICY IF EXISTS "company_settings_update" ON public.company_settings;
CREATE POLICY "company_settings_update" ON public.company_settings FOR UPDATE TO authenticated
    USING (public.auth_is_admin())
    WITH CHECK (public.auth_is_admin());

-- Tables with no client write policy are service-role only (RLS denies by default):
--   tasks, task_assignees, task_activity_logs, task_handoffs, expense_approvals,
--   roles, permissions, role_permissions, user_roles, user_departments,
--   invitations, conversations, conversation_members, audit_logs, notifications (insert).
