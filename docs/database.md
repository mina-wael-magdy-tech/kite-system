# PULSE STUDIO OS — Database Architecture & Schema Reference

## 1. Architectural Overview
The database architecture uses PostgreSQL on Supabase. It features complete third-normal-form (3NF) relational design, UUID primary keys, foreign key referential integrity constraints, server-written audit logging, and row-level security (RLS).

```
Identity & Profiles ───► Departments & Teams ───► Tasks & Projects
        │                           │                       │
        ▼                           ▼                       ▼
  Roles & RBAC               HR Attendance &         Communication,
  (Default-Deny)                 Leaves             Chat & Auditing
```

---

## 2. Table Catalog by Domain (48 Tables)

### 2.1 Identity & Access Control (9 Tables)
1. **`departments`**: The 5 creative studio hubs (Branding, BTL, Digital Marketing, Media Production, Web Development) plus custom departments.
2. **`profiles`**: Extends `auth.users` with studio profile metadata (employee ID, phone, job title, department, employment status, emergency contacts).
3. **`teams`**: Sub-teams within departments.
4. **`roles`**: System and custom roles (Super Admin, Owner, GM, Department Manager, Team Leader, Employee, PM, HR Manager, Finance Manager, Client).
5. **`permissions`**: Granular permissions categorized by module, action (view, create, edit, delete, assign, approve, export), and scope (own, assigned, team, department, company).
6. **`role_permissions`**: Many-to-many junction mapping roles to permissions.
7. **`user_roles`**: Many-to-many junction mapping users to assigned roles.
8. **`user_departments`**: Many-to-many junction linking specialists to departments.
9. **`invitations`**: Employee invitation tokens with expiration and audit status.

### 2.2 Task Management & Lifecycle (9 Tables)
10. **`tasks`**: Core deliverable records with 9 statuses (`backlog`, `todo`, `in_progress`, `under_review`, `changes_requested`, `approved`, `completed`, `cancelled`, `on_hold`) and 4 priorities (`urgent`, `high`, `medium`, `low`).
11. **`task_assignees`**: Collaborative multi-specialist assignments.
12. **`task_checklists`**: Deliverable checklist containers.
13. **`task_checklist_items`**: Individual checklist verification items.
14. **`task_comments`**: Collaboration notes, feedback, and discussion on tasks.
15. **`task_attachments`**: Digital assets linked to deliverables.
16. **`task_time_entries`**: Specialist hours logged against deliverables.
17. **`task_activity_logs`**: Server-generated audit trail of every status transition and reassignment.
18. **`task_handoffs`**: Cross-department task transfer requests.

### 2.3 Projects & Studio Campaigns (7 Tables)
19. **`projects`**: Multi-department client projects with budgets, progress percentages, and milestones.
20. **`project_members`**: Specialists staffed on projects.
21. **`project_departments`**: Departments collaborating on a project.
22. **`milestones`**: Key client launch deadlines and phases.
23. **`campaigns`**: Cross-department creative studio campaigns.
24. **`campaign_members`**: Campaign participants.
25. **`campaign_departments`**: Participating departments in studio campaigns.

### 2.4 CRM & Client Accounts (5 Tables)
26. **`clients`**: Client companies and portfolio accounts.
27. **`client_contacts`**: Stakeholder contact individuals.
28. **`leads`**: Deals in the 7-stage sales funnel.
29. **`opportunities`**: Deal probability and value projections.
30. **`client_activities`**: Logged client meetings, calls, and presentations.

### 2.5 HR Operations (5 Tables)
31. **`attendance_records`**: Daily check-in/check-out timestamps and hours.
32. **`leave_types`**: Configured leave categories (Annual, Sick, Personal, Remote).
33. **`leave_requests`**: Employee time-off requests with manager review status.
34. **`holidays`**: Official agency and regional holidays.
35. **`employee_documents`**: Confidential HR contracts and records.

### 2.6 Finance & Expenses (5 Tables)
36. **`budgets`**: Departmental, project, and company fiscal budgets.
37. **`expenses`**: Submitted expense claims with categories and receipt paths.
38. **`expense_approvals`**: Manager approval decision ledger.
39. **`vendors`**: External print, CNC, hardware, and software suppliers.
40. **`invoices`**: Accounts receivable and payable records.

### 2.7 Communication & Collaboration (4 Tables)
41. **`conversations`**: Group channels and direct 1-on-1 channels.
42. **`conversation_members`**: Chat participants and unread tracking.
43. **`messages`**: Live messages with support for instant task handoff cards.
44. **`message_attachments`**: Media shared in chat rooms.

### 2.8 System Ledgers & Settings (4 Tables)
45. **`notifications`**: Database-persisted user notifications.
46. **`notification_preferences`**: Specialist channel notification preferences.
47. **`audit_logs`**: Immutable security audit ledger.
48. **`company_settings`**: Global agency configuration (company info; `setup_lock` marks completed bootstrap).

---

## 3. Automation: what the database does and does not do
The database holds **schema and access control only**. Business logic is in Edge Functions (see `docs/security.md` §4).

- **`trg_set_updated_at`** (`003_updated_at.sql`): the only trigger. Sets `updated_at = NOW()` on update. Pure plumbing.
- **`EMP-001`, `TSK-101` identifiers**: plain column `DEFAULT`s backed by sequences (`employee_id_seq`, `task_number_seq`) in `001_initial_schema.sql`.
- **Task activity log, notifications, approvals, audit entries**: written by the `workflow` Edge Function. Clients have no write privilege on those tables.
- **Profile creation**: done by `invite-employee` / `setup-admin` (there is no `auth.users` trigger; signups are disabled).
- **Access-control predicates** (`auth_*` functions in `002_rls_policies.sql`): `SECURITY DEFINER`, `search_path = ''`, used only by RLS policies.
- **Dashboard metrics**: exact `count` queries from the browser, scoped by RLS (no RPC/aggregation function).
