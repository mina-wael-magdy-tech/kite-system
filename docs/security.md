# PULSE STUDIO OS — Security & Access Control Architecture

## 1. Principles
1. **The database is the authority.** Authorization is enforced by PostgreSQL Row Level Security (RLS) and column privileges. Client-side role checks only decide what to *show*.
2. **Default-deny.** `anon` has no privileges at all. `authenticated` receives only the table/column privileges listed in `supabase/migrations/002_rls_policies.sql`, narrowed by RLS.
3. **No business logic in SQL.** Migrations contain schema, access control and one plumbing trigger (`updated_at`). Workflow rules live in Edge Functions (§4).
4. **Server decides state changes.** Approvals, status transitions, role grants and audit entries are written by Edge Functions using the service role, after the caller is authenticated and authorized in code.
5. **Least privilege for people.** Only *active staff* get access. Suspended, onboarding and `client`-role accounts, and strangers who merely hold a valid JWT, see nothing.

## 2. Who can see and do what

| Domain | Read | Write (from the browser) | Write (server only) |
|---|---|---|---|
| `profiles` | self; any active staff (non-sensitive columns) | self: `full_name, phone, avatar_url, bio, skills, location, emergency_contact_*` | create, status, role, department, email (`invite-employee`, `accept-invitation`) |
| `departments`, `teams` | staff | admin (teams: + dept manager) | — |
| `roles`, `user_roles`, `user_departments`, `permissions` | staff | **nobody** | `invite-employee`, SQL editor |
| `tasks` | admin · department manager · creator · assignee · listed assignee · project manager | **nobody** | `workflow`: `task.create`, `task.set_status`, `task.reassign` |
| task comments / attachments / checklists / time | anyone who can see the task | same people (own rows) | — |
| `task_activity_logs`, `task_assignees`, `task_handoffs` | anyone who can see the task | **nobody** | `workflow` |
| `projects` + members/milestones | admin · PM · creator · member · department member | managers (create); admin/PM/creator (update) | — |
| `campaigns` | staff | managers (create); admin/owner (update) | — |
| CRM (`clients` read: staff; contacts, leads, opportunities, activities) | managers (leads also assignee/creator) | managers | — |
| `expenses` | submitter · finance manager · admin · department manager | submit own (`draft`/`submitted` only) | `workflow`: `expense.decide` |
| `invoices`, `vendors`, `budgets` | finance manager · admin (budgets also dept manager) | finance manager · admin | — |
| `attendance_records` | self · HR · admin | self (check-in; check-out/hours/notes) | — |
| `leave_requests` | self · HR · admin | submit own (`pending` only) | `workflow`: `leave.decide` |
| `employee_documents` | self · HR · admin | HR · admin | — |
| `conversations` / `messages` | public channels: all staff; others: members (+ admin read) | post where allowed (`text`/`task_handoff`) | create channels/members: service role |
| `notifications` | self | mark own as read | created by `workflow` |
| `audit_logs` | admin | **nobody** | Edge Functions |
| `company_settings` | staff | admin | `setup-admin` |

"Admin" = `super_admin`, `owner`, `general_manager`. "Manager" = admin + `department_manager`, `project_manager`, `team_leader`.

## 3. Threats considered and how they are handled

| Threat | Mitigation |
|---|---|
| Self-signup grants app access | Signups disabled (`config.toml`); every RLS predicate also requires an **active profile with a staff role**, so a stray auth user sees nothing |
| Privilege escalation via own profile | Column-level `UPDATE` grant excludes `employment_status, email, department_id, manager_id, employee_id, is_first_admin` |
| Role self-assignment / HR minting admins | No client write on role tables. `invite-employee` only lets admins grant admin-level roles and only a `super_admin` grant `super_admin` |
| Forged audit/activity/notification rows | No client `INSERT` grants on those tables. Audit table is append-only (no `UPDATE`/`DELETE` privilege exists) |
| Self-approval of expenses / leave | `expense.decide` / `leave.decide` reject the requester; transitions are conditional updates (`WHERE status = 'submitted'`), so double-decisions fail with 409 |
| Reading other people's DMs / posting into them | `auth_can_view_conversation` / `auth_can_post_conversation` require membership (or an `is_public` channel) |
| Suspended employee keeps working until token expiry | Every predicate checks `employment_status = 'active'` on each request |
| First-admin takeover (`setup-admin`) | Requires `SETUP_TOKEN` secret, atomic DB lock, refuses if a super admin exists, rolls back on failure; delete the function after use |
| Stored XSS | All dynamic text goes through `escapeHTML` (including notifications, project/department codes, router errors); strict **CSP** forbids inline/remote scripts |
| Supply-chain (CDN compromise) | Third-party libraries are **vendored at pinned versions** under `vendor/`; no external script origins |
| CSV/formula injection in exports | Cells starting with `= + - @` are neutralised; export uses a Blob (no `#`-truncation) |
| Malicious uploads | Private bucket, 25 MB cap, extension allow-list (no SVG), per-task access via storage policies, short-lived signed URLs served as attachments |
| Clickjacking | `frame-ancestors` allows only this origin and Google Sites |
| CORS abuse of Edge Functions | Exact-origin allow-list (`ALLOWED_ORIGINS`); fails closed when unset |
| Information leaks from errors | Edge Functions return generic 500s; details go to server logs only |
| `SECURITY DEFINER` hijacking | All predicates pin `search_path = ''` and are schema-qualified; `EXECUTE` revoked from `PUBLIC`/`anon` |

## 4. Where business logic lives

| Function | Responsibility |
|---|---|
| `workflow` | `task.create` (derives department from assignee, validates project visibility), `task.set_status` (transition map, reviewer gate for `approved`/`completed`), `task.reassign`, `expense.decide`, `leave.decide`. Writes activity log, notifications and audit entries |
| `invite-employee` | Admin/HR invitation: role-grant rules, creates auth user + profile + role + invitation, **rolls back** on any failure |
| `accept-invitation` | Activates an invited account (validates invitation exists and is not expired) |
| `setup-admin` | One-time bootstrap of the first super admin |

Human-readable IDs (`EMP-001`, `TSK-101`) are plain column defaults backed by sequences.

## 5. Known limitations (be aware, not blockers)
- **Emergency contacts are write-only for users** (not selectable from the browser); HR reads them via the service role or SQL editor.
- Attendance timestamps are client-reported; RLS cannot verify their truthfulness.
- The `client` role exists but there is no client portal; such users can only read their own profile.
- No built-in rate limiting beyond Supabase Auth limits (`config.toml`); put the site behind Cloudflare or similar for WAF/bot protection.
- Private channels such as `#client-briefs` need members added via SQL/service role (no UI yet).
- Sessions use `localStorage` (standard for supabase-js). The CSP is the main defence against token theft.

## 6. Verification
The access model was tested by running all migrations against PostgreSQL and attacking them as anonymous, stranger, suspended, client-role, employee, HR, finance and admin users (71 scenarios: escalation, forgery, cross-user reads, storage paths). Re-run after any policy change; see `docs/production-checklist.md` §5.
