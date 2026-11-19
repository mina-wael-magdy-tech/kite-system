# Architecture, Dependency & Documentation Issues

6 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| ARC-01 | Role model duplicated in SQL, Edge Functions and JS; role tiers not enforced consistently (general_manager over owner/super_admin; HR over ceo/finance roles) | HIGH | P1 | Strong Evidence | FX-02, FX-01 | Source fix implemented on branch fix/arc-01-role-tiers incl. executive-only Finance (migrations 020-025; tested locally, NOT deployed); production verification pending |
| ARC-02 | God modules and no module contract in the browser | LOW | P3 | Confirmed | FX-09 | Open |
| DOC-01 | docs/database.md lists 48 tables; migrations create 68 | LOW | P3 | Confirmed | FX-14 | Open |
| DOC-02 | Docs say 'only one trigger / no business logic in SQL'; code has 48 trigger instances and finance logic in SQL | LOW | P3 | Confirmed | FX-14 | Open |
| DOC-03 | Production checklist is stale and contradicts the code (migrations, buckets, RLS test, HR role limits) | LOW | P3 | Confirmed | FX-14 | Open |
| ARC-03 | Invitation token column unused; activation keyed by email only; legacy invoice columns kept | INFORMATIONAL | P3 | Confirmed | FX-15 | Open |

### ARC-01 — Role model duplicated in SQL, Edge Functions and JS; role tiers not enforced consistently (general_manager over owner/super_admin; HR over ceo/finance roles)

| Field | Value |
|---|---|
| Category | Architecture |
| Severity | HIGH |
| Priority | P1 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Major / Medium / L |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | ARC-01 |
| Affected module | Authorization / identity |
| Affected files | `supabase/functions/invite-employee/index.ts:L14,L19,L33-L34,L59-L64`<br>`supabase/functions/workflow/index.ts:L276,L413,L429,L469`<br>`supabase/functions/_shared/auth.ts:L5`<br>`supabase/migrations/002_rls_policies.sql:L71-L94`<br>`supabase/migrations/015_owner_only_money_and_client_scope.sql:L16-L27`<br>`supabase/migrations/017_finance_invoicing.sql:L19-L35`<br>`supabase/functions/kite-drive/index.ts:L55`<br>`js/permissions/permission-service.js:L72,L83`<br>`js/modules/broadcast/broadcast.js:L14`<br>`js/services/money.js:L10`<br>`docs/production-checklist.md (section 4)` |
| Relevant functions | `ADMIN_LEVEL (invite-employee)`, `ADMIN_LEVEL_ROLES (employeeUpdate)`, `ADMIN_ROLES`, `auth_is_admin()`, `auth_is_owner()`, `auth_is_finance()`, `isDriveAdmin` |
| Graph node IDs | `fn:invite-employee`, `fn:workflow`, `shared:auth`, `sql:auth_is_admin`, `sql:auth_is_owner`, `sql:auth_is_finance`, `fn:kite-drive`, `fe:permissions`, `tbl:user_roles`, `tbl:roles` |
| Related workflows | Employee invitation to activation, Expense and leave approval |
| Related tables | `user_roles`, `roles`, `profiles`, `invitations` |
| Fix package | FX-02, FX-01 |
| Status | Source fix implemented on branch fix/arc-01-role-tiers incl. executive-only Finance (migrations 020-025; tested locally, NOT deployed); production verification pending |

**Description.** Admin-tier is defined three ways: SQL auth_is_admin = super_admin/owner/general_manager; SQL auth_is_owner = super_admin/owner/ceo; Edge ADMIN_ROLES = super_admin/owner/general_manager. invite-employee and employee.update protect only that admin list. Consequences confirmed in code: (a) an hr_manager can invite or assign the 'ceo' role (owner-tier money and all-client access under RLS) and finance_manager/accountant; (b) an hr_manager can edit, deactivate/ban or delete a 'ceo' account because ceo is not in the protected list; (c) general_manager can approve expenses (workflow L276) yet cannot read expenses under RLS (015 owner/finance only); (d) kite-drive special-cases ceo to compensate; (e) the 'ceo' role is not created by seed.sql or any migration read. CORRECTION 2026-11-07 (source-confirmed, not production-verified): HR is already blocked from granting or modifying super_admin/owner/general_manager. The larger source finding is that a general_manager (an 'admin') could grant the owner role, create an owner account it controls, and deactivate or delete owners and the super_admin; the last-super-admin check applied only to role changes, not to status change or delete; role replacement was a non-atomic delete+insert (DAT-05). SECOND PASS 2026-11-07: last-active-super_admin race reproduced on real PostgreSQL and closed by migration 023; confidential contracts in the document library made executive-only (024); historic financial notifications to non-executives have a reversible redaction (025, needs owner approval); Kite Drive remains unclassified (open); a pre-existing fail-closed bug in the 007 studio-assets read policy was found (reported, unchanged). POLICY APPROVED 2026-11-07: super_admin, owner and ceo are one equal executive tier and the only roles that may view Finance data or grant finance_manager/accountant; migration 017 had widened Finance reads to finance_manager/accountant (source-confirmed), now reverted by migration 022 (see phase-0/FINANCE_ACCESS_AUDIT.md). Production reports (not re-observed by this audit): no users hold hr_manager; two hold owner, one super_admin, one general_manager; existence of a ceo role not established.

**Root cause.** No single capability source: each layer hard-codes role names, and later migrations (015, 017) introduced new tiers without updating the earlier Edge Function lists.

**Reproduction (safe).** Staging only: create roles ceo and hr_manager users; as hr_manager call invite-employee with the ceo roleId and with employee.update on a ceo user. Expect success today; expected result is 403.

**Impact.** Privilege escalation to owner-tier financial visibility and denial-of-access against the CEO by a non-admin HR account. Also wrong or blind approvals and future drift on every role change.

**Fix.** Interim (no migration, same day): add 'ceo','finance_manager','accountant' (and any tier that RLS treats as privileged) to ADMIN_LEVEL / ADMIN_LEVEL_ROLES in invite-employee and workflow, and to the target-protection checks. Durable: add roles.capabilities text[] (or role_capabilities table) and SQL fn auth_has_capability(text); getCaller loads capabilities; Edge checks use caller.can('x'); browser reads capabilities via one RPC. Replace all name lists. Decide whether general_manager may approve expenses and align RLS.

**Acceptance criteria.** Role-matrix test passes for every (role x action) in SQL, Edge and UI; hr_manager gets 403 granting/editing/deleting ceo, owner, finance roles; no role-name literal remains outside the seed.

**Required tests.** Matrix test across roles: super_admin, owner, ceo, general_manager, hr_manager, finance_manager, accountant, manager, employee, client, suspended - for invite, update, delete, expense decide, broadcast, drive link.

**Verification method.** Run the matrix in CI; on live run: SELECT name FROM roles WHERE name='ceo'; list users holding ceo/finance roles and who assigned them (user_roles.assigned_by).

**Why this classification.** High (classification unchanged): privilege-escalation paths to owner tier exist in source (general_manager over owner/super_admin; HR over ceo/finance). Exploitability depends on live state: a general_manager exists in production per report; hr_manager holders and a ceo role are not present per report. Strong Evidence, not Confirmed, because live behaviour was not tested.

---

### ARC-02 — God modules and no module contract in the browser

| Field | Value |
|---|---|
| Category | Architecture |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / L |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Frontend |
| Affected files | `js/modules/chat/chat.js (1195 lines)`<br>`js/modules/campaigns/content-plan.js (1094)`<br>`js/modules/tasks/tasks.js (1082)`<br>`js/modules/clients/drive-panel.js (904)`<br>`supabase/functions/workflow/index.ts (677)` |
| Relevant functions | `ChatModule`, `ContentPlanEditor`, `TasksModule`, `DrivePanel` |
| Graph node IDs | `fe:chat`, `fe:campaigns`, `fe:tasks`, `fe:clients`, `fn:workflow` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-09 |
| Status | Open |

**Description.** Large multi-responsibility classes mix data access, rules, rendering and realtime; every module talks to supabase directly (162 call sites); graph hubs getSupabase() 118 and escapeHTML() 94 edges.

**Root cause.** Feature growth without layering.

**Reproduction (safe).** n/a

**Impact.** Hard to change and test; supports FUN-01-type defects.

**Fix.** Introduce per-domain data modules (api layer), view components, and the mount/unmount contract (FX-09); split workflow/index.ts by domain.

**Acceptance criteria.** No module over 600 lines; data access in a services layer.

**Required tests.** n/a

**Verification method.** Line counts.

**Why this classification.** Low: maintainability.

---

### DOC-01 — docs/database.md lists 48 tables; migrations create 68

| Field | Value |
|---|---|
| Category | Documentation |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | DOC-01 |
| Affected module | Documentation |
| Affected files | `docs/database.md:L16` |
| Relevant functions | — |
| Graph node IDs | `tbl:content_plans`, `tbl:invoices` |
| Related workflows | — |
| Related tables | `content_plans`, `money_figures`, `retainer_plans`, `client_drive_links` |
| Fix package | FX-14 |
| Status | Open |

**Description.** 19 tables are not mentioned at all (push_subscriptions, task_links, content_*, client_departments, broadcasts, money_figures, message_reactions, finance_settings, client_billing, retainer_plans, invoice_items, invoice_payments, invoice_number_seq, finance_audit_log, client_drive_links).

**Root cause.** Docs not updated after migrations 005-019.

**Reproduction (safe).** Diff table names in docs vs migrations (script in system-graph).

**Impact.** Misleads engineers.

**Fix.** Generate the table catalog from migrations in CI.

**Acceptance criteria.** Doc lists all 68 tables, generated.

**Required tests.** CI diff check.

**Verification method.** Run the diff.

**Why this classification.** Low: documentation only.

---

### DOC-02 — Docs say 'only one trigger / no business logic in SQL'; code has 48 trigger instances and finance logic in SQL

| Field | Value |
|---|---|
| Category | Documentation |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | DOC-02 |
| Affected module | Documentation |
| Affected files | `docs/database.md:L87`<br>`docs/security.md:L6`<br>`supabase/migrations/003_updated_at.sql:L1-L8` |
| Relevant functions | — |
| Graph node IDs | `sql:set_updated_at`, `sql:fin_invoice_guard`, `sql:blank_money_columns` |
| Related workflows | Invoice lifecycle (finance) |
| Related tables | `invoices`, `invoice_items`, `content_posts` |
| Fix package | FX-14 |
| Status | Open |

**Description.** Triggers: set_updated_at 28, fin_audit 7, blank_money_columns 6, fin_block_change 3, and one each of content_posts_guard, fin_item_calc, fin_invoice_guard, fin_payment_guard.

**Root cause.** Docs predate 012/015/017.

**Reproduction (safe).** Count CREATE TRIGGER in migrations.

**Impact.** Engineers look for rules only in Edge Functions.

**Fix.** Rewrite the sections; list trigger functions and where business rules live.

**Acceptance criteria.** Docs match the schema.

**Required tests.** n/a

**Verification method.** Review.

**Why this classification.** Low.

---

### DOC-03 — Production checklist is stale and contradicts the code (migrations, buckets, RLS test, HR role limits)

| Field | Value |
|---|---|
| Category | Documentation |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Documentation |
| Affected files | `docs/production-checklist.md (sections 1, 4, 5)` |
| Relevant functions | — |
| Graph node IDs | `fn:invite-employee`, `bkt:studio-assets`, `bkt:chat-media` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-14 |
| Status | Open |

**Description.** It says apply migrations 001-004 (there are 19), 'only the private task-attachments bucket exists' (studio-assets and chat-media exist), the suite 'applies all migrations' and runs 79 scenarios (it runs 153 and applies a subset), and that HR cannot grant owner/general_manager/super_admin (true) without mentioning ceo and finance roles that HR can grant.

**Root cause.** Not maintained.

**Reproduction (safe).** Compare with repo.

**Impact.** Operators follow an incomplete checklist.

**Fix.** Rewrite from the current repo; add ceo/finance role checks and all buckets; generate counts from CI.

**Acceptance criteria.** Checklist matches repo and CI.

**Required tests.** n/a

**Verification method.** Review.

**Why this classification.** Low.

---

### ARC-03 — Invitation token column unused; activation keyed by email only; legacy invoice columns kept

| Field | Value |
|---|---|
| Category | Architecture |
| Severity | INFORMATIONAL |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Identity / finance |
| Affected files | `supabase/functions/invite-employee/index.ts:L123`<br>`supabase/functions/accept-invitation/index.ts:L14-L22`<br>`supabase/migrations/017_finance_invoicing.sql (amount/tax legacy columns)` |
| Relevant functions | `invitations.token`, `fin_recalc_invoice legacy columns` |
| Graph node IDs | `fn:invite-employee`, `fn:accept-invitation`, `tbl:invitations`, `tbl:invoices` |
| Related workflows | Employee invitation to activation |
| Related tables | `invitations`, `invoices` |
| Fix package | FX-15 |
| Status | Open |

**Description.** invitations.token is generated but never validated; acceptance matches the pending invitation by lowercase email of the authenticated user. invoices.amount and tax are legacy columns kept in step with new totals.

**Root cause.** Evolution of the schema.

**Reproduction (safe).** n/a

**Impact.** Dead data and extra coupling.

**Fix.** Remove the unused token or use it; drop legacy columns after confirming no reader.

**Acceptance criteria.** Columns removed or used.

**Required tests.** n/a

**Verification method.** grep.

**Why this classification.** Informational.

---
