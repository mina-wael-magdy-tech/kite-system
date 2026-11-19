# 04 — Database architecture

Source: `supabase/migrations/001–019` (statically). Live schema **not inspected**; live migration history is empty (project memory), so repo ≠ guaranteed live state.

## Tables (68 distinct `CREATE TABLE IF NOT EXISTS public.*` across the migrations; 74 distinct CREATE TABLE targets overall, the difference being tables in other schemas such as the `finance_backup` schema in 017 — not inspected)
Identity/access: `profiles`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_departments`, `teams`, `departments`, `invitations` · Tasks: `tasks`, `task_assignees`, `task_checklists`, `task_checklist_items`, `task_comments`, `task_attachments`, `task_activity_logs`, `task_handoffs`, `task_links`, `task_time_entries` · Projects/campaigns: `projects`, `project_members`, `project_departments`, `milestones`, `campaigns`, `campaign_members`, `campaign_departments` · CRM/clients: `clients`, `client_contacts`, `client_departments`, `client_activities`, `client_billing`, `client_drive_links`, `leads`, `opportunities` · Content: `content_plans`, `content_posts`, `content_post_assets`, `content_feedback`, `content_plan_shares`, `assets` · HR: `attendance_records`, `leave_requests`, `leave_types`, `holidays`, `employee_documents` · Finance: `invoices`, `invoice_items`, `invoice_payments`, `invoice_number_seq`, `retainer_plans`, `finance_settings`, `finance_audit_log`, `expenses`, `expense_approvals`, `budgets`, `vendors`, `money_figures` · Comms: `conversations`, `conversation_members`, `messages`, `message_attachments`, `message_reactions`, `notifications`, `notification_preferences`, `push_subscriptions`, `broadcasts` · System: `audit_logs`, `company_settings` (also used as the setup lock).

## Relationships
Extracted FKs: `diagrams/ER_DIAGRAM.mmd` (script-extracted from single-line `REFERENCES public.*`). A few multi-line declarations were not attributed to a column by the script (e.g. `retainer_plans` links to departments/profiles/projects/tasks, a `profiles` self-reference) and are drawn from the script's output only where the table was clear — treat the diagram as a close approximation, not a generated-from-live-schema artifact.

Delete behaviour summary: 94 `ON DELETE` clauses in 001. Pattern: owned children `CASCADE` (task_*, content_*, conversation_*), people references `SET NULL` (created_by, assigned_to), money-bearing `RESTRICT` (017 retainer_plans→clients).

## Relationships enforced only in application/SQL logic, not by FK
- `money_figures(entity, entity_id)` is a polymorphic reference (CHECK on entity names, no FK) → orphan rows possible when a client/project/campaign is deleted.
- `client_drive_links.drive_user_id` points to MySQL `users.id` on another server — cannot be enforced; deleted Drive users leave dangling links (Drive API rejects such tokens: "Drive client not found").
- Storage object paths in `content_post_assets.storage_path` / chat/task attachments are strings; 012 adds a CHECK for the folder shape (`NOT VALID`, so old rows unchecked).
- `invitations.email` ↔ `auth.users.email` joined by lowercase email in `accept-invitation`.
- `entity_id` in `audit_logs`/`finance_audit_log` is free text.

## Constraints / integrity worth noting
- Money: `NUMERIC(15,2)` with `amount >= 0`; invoice maths in SQL; sequence table with `FOR UPDATE` for gapless numbers.
- `content_post_assets_path_check` is `NOT VALID` → not enforced on existing rows until validated.
- `client_drive_links.drive_user_id UNIQUE` prevents two clients sharing a Drive account (code maps `23505`→409).
- Triggers: `updated_at` (003), `content_posts_guard` (012), `blank_money` ×6 (015), `fin_item_calc`, `fin_invoice_guard`, `fin_payment_guard`, `fin_no_delete`, `fin_no_change`, `fin_audit` (017).
- Indexes: 54 `CREATE INDEX` statements across migrations; missing/redundant index analysis **not performed** (needs query log).
- RLS: enabled on all tables per hardening intent; `anon` revoked everywhere (002 L28–33, 012). Verify live with check queries in 012.

## Problem checklist (from brief)
| Problem | Result |
|---|---|
| Missing FKs | polymorphic `money_figures`; cross-system `drive_user_id` (by nature) |
| Orphans | `money_figures` on entity delete (Plausible) |
| Naming consistency | consistent snake_case, `created_by/updated_by` pattern |
| Nullable that shouldn't be | not enumerated |
| Race conditions | invoice numbering/pay/void use `FOR UPDATE`; invitation accept uses conditional update; client-preview rate limit racy (SEC-01) |
| N+1 / unbounded queries | not assessed (frontend unread) |
| Migration inconsistencies | all migrations written idempotent ("safe to run twice"); live history empty → drift risk |
| Tight coupling | `profiles` carries identity, HR, employment, hierarchy; column-grant list must stay in sync with `config.js PROFILE_COLUMNS` |

## Data lifecycle highlights
- Invoice: draft (editable) → issued (number, frozen) → paid/overdue (cron) → void (reasoned); payments reversible not deletable; everything audited.
- Content plan: draft → shared (token) → approved/changes_requested (client or staff).
- Employee: invited → `onboarding` → `active` (via accept-invitation) → suspended etc.
