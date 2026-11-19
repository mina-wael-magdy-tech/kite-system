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
| `expenses`, `expense_approvals` | **executives only** (super_admin, owner, ceo) | staff may INSERT their own claim (`draft`/`submitted`); it cannot be read back | `workflow`: `expense.decide` (executives only) |
| `invoices`, `invoice_items`, `invoice_payments`, `retainer_plans`, `client_billing`, `finance_settings`, `vendors`, `budgets`, `money_figures`, `finance_audit_log` | **executives only** (super_admin, owner, ceo); finance_manager and accountant have no access | none directly; writes go through the `finance` Edge Function (executives only) and `fin_*` SQL functions (service role) | `finance` |
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

## 4b. Push notifications
Devices subscribe through the server (never directly), only real push-service endpoints are accepted (SSRF guard), the device keys are not readable from the browser, sign-out removes the device, and notification taps cannot open external sites. Details: `docs/pwa-and-notifications.md` §4.

## 5. Known limitations (be aware, not blockers)
- **Emergency contacts are write-only for users** (not selectable from the browser); HR reads them via the service role or SQL editor.
- Attendance timestamps are client-reported; RLS cannot verify their truthfulness.
- The `client` role exists but there is no client portal; such users can only read their own profile.
- No built-in rate limiting beyond Supabase Auth limits (`config.toml`); put the site behind Cloudflare or similar for WAF/bot protection.
- Private channels such as `#client-briefs` need members added via SQL/service role (no UI yet).
- Sessions use `localStorage` (standard for supabase-js). The CSP is the main defence against token theft.

## 6. Verification
The access model was tested by running all migrations against PostgreSQL and attacking them as anonymous, stranger, suspended, client-role, employee, HR, finance and admin users (79 scenarios: escalation, forgery, cross-user reads, storage paths). Re-run after any policy change; see `docs/production-checklist.md` §5.

## Role tiers and Finance confidentiality (policy approved 2026-11-07, migrations 020-022)
- **Executive tier = super_admin, owner, ceo** (one equal tier). Only they may view Finance data anywhere and only they may grant `finance_manager` / `accountant`. Being in the Finance department grants nothing.
- Employee management (`invite-employee`, `workflow employee.update`) is open to executives, general_manager and hr_manager. A caller may grant a role / modify / disable / delete an account only at or below their own tier (general_manager 2, finance roles 3, hr_manager 4, everyone else 5); executives manage each other.
- The last **active** super_admin can never be demoted, disabled or deleted, enforced by database triggers (migration 023, serialized with an advisory lock, tested on real PostgreSQL by `supabase/tests/verify-concurrency.mjs`). Role replacement is atomic (`replace_user_role()`).
- Library files in a **Contracts** folder (or flagged `assets.finance_confidential`) are executive-only, including their Storage objects (migration 024).
- Single source in code: `supabase/functions/_shared/auth.ts` (`EXECUTIVE_ROLES`, `ROLE_TIER`). In SQL: `auth_is_finance()` (= executive) and `auth_is_owner()`; in the UI: `js/services/money.js`. `supabase/tests/verify-roles.mjs` fails if they drift apart.
- Open gaps and decisions: `docs/system-architecture-audit/phase-0/FINANCE_ACCESS_AUDIT.md`.

## Plan assets, library assets and client files: integrity rules (migrations 026 and 027)
- **Plan visuals (`content_post_assets`)**: a database trigger makes `storage_path`, `plan_id` and `uploaded_by` immutable after the row is created, and refuses a row without an uploader. Before 027 an editor could set `uploaded_by = NULL` and `storage_path` to any path in one UPDATE (the path CHECK from 012 allows a NULL owner); the staff-wide Storage read policy and the public share link then served that object. The only allowed owner change is the foreign-key action `ON DELETE SET NULL` (the uploader's profile was deleted), detected by checking that the profile no longer exists.
- **Legacy rows with a NULL owner are never rewritten or re-owned.** Editors can still change their metadata (layout, position, post, file name) and delete them; nobody can claim them, change their path, or move them to another plan. To replace one, delete it and upload again.
- **Library files (`assets`)**: `storage_path` must start with the uploader's id on insert and never changes (026). `uploaded_by` and `client_id` can only be changed by an executive (or a session with no end user: service role / SQL editor); a non-executive can only attach a file to a client they can see and can never detach it from its client (027). Client files follow `auth_can_see_client(client_id)` in addition to their visibility; executives see all; the uploader keeps access to their own uploads (documented exception, see below).
- **Uploader exception, actual behaviour**: the uploader keeps read, edit and delete access to their own client uploads even after moving department or losing access to the client. It ends when the account is deactivated, suspended or switched to the client role. An executive can transfer ownership, which gives the new owner the same exception.
- **Rollback of 027**: `DROP TRIGGER IF EXISTS content_post_assets_guard ON public.content_post_assets; DROP FUNCTION IF EXISTS public.content_post_assets_guard(); DROP TRIGGER IF EXISTS assets_integrity_guard ON public.assets; DROP FUNCTION IF EXISTS public.assets_integrity_guard();` (no data is changed by the migration). Rollback of 026: drop `trg_assets_path_guard` and `assets_path_guard()` and restore the policies from 024.
- **Warning**: re-running migration 024 after 026 replaces the 026 `assets` policies with the older ones and silently removes the client scoping. Re-run 026 afterwards.
- **Staging-only checks**: the real Supabase Storage API (signed URLs, bucket settings) and the live `studio_assets_read` policy (migration 007 as written matches no object; its intended form is `a.storage_path = objects.name`); `content_post_assets` rows with `uploaded_by IS NULL` and `assets` rows whose path does not start with the uploader id (legacy data, count them first); Realtime delivery of changed rows; gzip request bodies against the real runtime; the two-department client scoping with real accounts.

## Finance integrity rules (migration 028, Phase 3.A)

- **Locking.** Every writer of an invoice's figures holds the invoice row lock in the same order (invoice first, then payment). `fin_payment_reverse` used to lock only the payment, so a payment or a second reversal running at the same moment could leave `amount_paid` wrong. `fin_recalc_invoice` now also takes the lock and writes the totals and the status in one statement.
- **Idempotent payments.** `payment.add` requires a `requestId` (UUID, one per dialog). The database keeps it in `invoice_payments.request_id` (unique); repeating an identical request returns the same payment; reusing an id with any different invoice, amount, date, method, reference or notes is refused; replaying the id of a payment that was reversed since raises an explicit "has since been reversed" error (not a success). Callers of the SQL function that send no id keep working (the argument is optional there; the Edge Function requires it).
- **Issuing.** An invoice needs a client and a net receivable above zero (100% withholding with 0% VAT cannot be saved or issued). The same rules are enforced by the status-transition guard, so a direct status change cannot bypass them. An issued invoice can never go back to draft.
- **Constraints.** Six CHECKs on `invoices` (non-negative amounts, paid within net, total = subtotal + VAT, balance = net - paid, paid status means zero balance, no draft number on an issued invoice) and a deferred trigger that makes `amount_paid` equal the sum of live payments at COMMIT. They are added NOT VALID and validated only if the existing data already complies; otherwise the migration prints a NOTICE and the constraint stays NOT VALID (new writes are still checked). Re-run 028 after cleaning the data to validate.
- **Retainers.** One active plan per client + department + name (unique index, created only when no duplicates exist). Concurrent monthly runs queue on an advisory lock and skip plans already billed.
- **Reconciliation.** `fin_reconcile_invoices()` (service_role only, read-only) lists invoices whose stored figures disagree with their lines or payments; the `finance` function exposes it as the `reconcile` action (executives only).
- **Tests.** `supabase/tests/verify-finance-concurrency.mjs` (real PostgreSQL; `npm run test:finance-concurrency`) shows each race failing without 028 and holding with it. Rollback commands are in the migration header.
- **Re-running 017.** Migration 017 is idempotent but re-creates the original bodies of eight finance functions and the 7-argument `fin_payment_add`, which silently undoes this phase. **Always re-apply, in this order, 022, 028, 033, 035, 036 and 037 after any re-run of 017** (022 restores executive-only Finance: without it `auth_is_finance()` and the finance policies are back to their 017 form and the finance-manager and accountant roles regain access) (Phase 3.E re-states the same functions with the studio business date and the operator-only migration switch), and check that `SELECT count(*) FROM pg_proc WHERE proname = 'fin_payment_add'` returns 1. The part 017 -> 028 -> 033 is tested in `verify-integrity.mjs`; the full sequence was verified on a scratch database.

## Phase 3.B-3.E: history protection, HR and approval integrity, atomic operations, hygiene (migrations 029 to 033)

Rules, apply order, rollback, detectors and the decisions still open are in [database-integrity.md](database-integrity.md). In short: people and
business records with history cannot be deleted (deactivate / archive); files are removed after their rows, through a retried queue; attendance
time is the server's; leave and expenses follow enforced rules; approvals and their evidence are atomic and invalidated by changes; department,
money-figure, Kite Drive, reaction, membership, reminder, broadcast and invitation changes cannot half-happen or double-happen; audit logs are
append-only; Finance uses the studio's business date. The executive-only Finance policy and every Phase 1, 2 and 3.A protection are unchanged.

## Phase 4: Drive tokens, router lifecycle, employee activation (migration 034)

* **Drive tokens** carry a unique id; an address-carried token is single-use (download, ZIP) or locked to one file (preview), thumbnails and the logo use the `X-Drive-Token` header, and the signing secret never leaves the Edge Function. Policy switch: `url_tokens` (`legacy` / `strict`) in Drive's `config.php`.
* **Activation**: `accept_invitation()` (service role only) activates the account and consumes the invitation in one transaction; a bound invitation is never matched to another account by e-mail; an expired or revoked invitation never activates; the stored token is a hash.
* **Frontend**: pages are disposed on navigation (module contract + `Scope`), so a page that was left holds no realtime channel, listener or timer.
Details, release order and rollback: [phase4-release.md](phase4-release.md).
