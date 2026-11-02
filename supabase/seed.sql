-- ====================================================================
-- PULSE STUDIO OS — seed.sql
-- Seed Data: System Roles, Permissions, Departments, Leave Types & Settings
-- ====================================================================

-- 1. Initial 5 Creative Studio Departments
INSERT INTO public.departments (id, name, code, description) VALUES
    ('11111111-1111-1111-1111-111111111101', 'Branding', 'BRAND', 'Brand strategy, visual identity systems, typography & packaging design'),
    ('11111111-1111-1111-1111-111111111102', 'BTL', 'BTL', 'Below The Line activations, exhibition booths, pop-up kiosks & print production'),
    ('11111111-1111-1111-1111-111111111103', 'Digital Marketing', 'MKTG', 'Performance ads, social media campaigns, SEO/SEM & digital growth funnels'),
    ('11111111-1111-1111-1111-111111111104', 'Media Production', 'MEDIA', 'Video directing, motion graphics, 3D animations, reels & audio engineering'),
    ('11111111-1111-1111-1111-111111111105', 'Web Development', 'DEV', 'Full-stack web applications, e-commerce storefronts, interactive WebGL & UI/UX')
ON CONFLICT (name) DO NOTHING;

-- 2. Initial System Roles (10 Roles)
INSERT INTO public.roles (id, name, display_name, description, is_system, priority) VALUES
    ('22222222-2222-2222-2222-222222222201', 'super_admin', 'Super Admin', 'Full system control, role permissions, integrations & master configuration', true, 1),
    ('22222222-2222-2222-2222-222222222202', 'owner', 'Owner / CEO', 'Company-wide executive oversight, financial metrics & strategic approvals', true, 2),
    ('22222222-2222-2222-2222-222222222203', 'general_manager', 'General Manager', 'Operational leadership across all studio departments & cross-team campaigns', true, 3),
    ('22222222-2222-2222-2222-222222222204', 'department_manager', 'Department Manager', 'Oversees departmental deliverables, workload balancing & creative reviews', true, 4),
    ('22222222-2222-2222-2222-222222222205', 'team_leader', 'Team Leader', 'Leads sub-teams, assigns sprint tasks & reviews initial deliverable drafts', true, 5),
    ('22222222-2222-2222-2222-222222222206', 'employee', 'Employee / Specialist', 'Executes creative deliverables, submits progress & collaborates across studio', true, 6),
    ('22222222-2222-2222-2222-222222222207', 'project_manager', 'Project Manager', 'Cross-department timeline, milestone tracking, client briefs & budgets', true, 5),
    ('22222222-2222-2222-2222-222222222208', 'hr_manager', 'HR Manager', 'People operations, attendance tracking, leave requests & talent onboarding', true, 4),
    ('22222222-2222-2222-2222-222222222209', 'finance_manager', 'Finance Manager', 'Budgeting, expense approvals, vendor payables & client invoicing', true, 4),
    ('22222222-2222-2222-2222-222222222210', 'client', 'Client / Guest', 'External client stakeholder access to view permitted deliverables & feedback', true, 10)
ON CONFLICT (name) DO NOTHING;

-- 3. Standard Leave Types
INSERT INTO public.leave_types (name, description, default_days) VALUES
    ('Annual Leave', 'Paid time off for holidays and vacation', 21),
    ('Sick Leave', 'Medical or health recuperation leave', 10),
    ('Personal / Emergency', 'Short-notice emergency family or personal matters', 5),
    ('Remote Work Request', 'Configured remote execution days', 12)
ON CONFLICT (name) DO NOTHING;

-- 4. Default Communication Channels
-- is_public = open to all staff. #client-briefs is private: add its members
-- explicitly (conversation_members) via the SQL editor / service role.
INSERT INTO public.conversations (id, type, name, description, is_public) VALUES
    ('33333333-3333-3333-3333-333333333301', 'group', '#creative-handoffs', 'Cross-department task handoffs & asset deliveries across all studio roles', true),
    ('33333333-3333-3333-3333-333333333302', 'group', '#studio-general', 'Daily standups, studio announcements & creative alignment', true),
    ('33333333-3333-3333-3333-333333333303', 'group', '#client-briefs', 'Manager & Admin campaign briefs, deliverables and milestone updates', false)
ON CONFLICT (id) DO NOTHING;

-- 5. Default Company Settings
INSERT INTO public.company_settings (key, value) VALUES
    ('company_info', '{
        "name": "PULSE STUDIO",
        "tagline": "Creative Agency Operating System",
        "website": "https://pulsestudio.agency",
        "timezone": "UTC+02:00",
        "currency": "USD"
    }'::jsonb)
ON CONFLICT (key) DO NOTHING;
