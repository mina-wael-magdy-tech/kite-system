# Master Issue Register
Generated from `issues_data.py` (single source). Date: 2026-11-06. Repo: `main` @ `5e951e1`.

**Totals:** 37 issues (14 preserved from the previous audit with unchanged IDs, 23 new). Duplicate symptoms are grouped under one root issue.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 15 |
| LOW | 20 |
| INFORMATIONAL | 1 |

| Confidence | Count |
|---|---|
| Confirmed | 23 |
| Strong Evidence | 4 |
| Potential | 7 |
| Unverified | 3 |

| Priority | Count |
|---|---|
| P0 | 0 |
| P1 | 5 |
| P2 | 13 |
| P3 | 19 |

**Evidence basis.** All findings rest on source/SQL reading. One runtime observation exists: the in-process RLS suite was executed (153 passed, 0 failed; see OPS-02). No live Supabase, Vercel or Hostinger inspection was possible. "Confirmed" means the behaviour follows directly from code that was read (or executed); it does not mean it was observed in production.

**No P0.** No issue is confirmed critical. ARC-01 becomes an immediate patch (interim fix in FX-01) if verification shows that a `ceo` role exists live.

## Register (sorted by severity, then priority)
| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| ARC-01 | Role model duplicated in SQL, Edge Functions and JS; role tiers not enforced consistently (general_manager over owner/super_admin; HR over ceo/finance roles) | HIGH | P1 | Strong Evidence | FX-02, FX-01 | Source fix implemented on branch fix/arc-01-role-tiers incl. executive-only Finance (migrations 020-025; tested locally, NOT deployed); production verification pending |
| OPS-01 | Scheduled jobs exist only in the Supabase dashboard; no heartbeat or alerting | MEDIUM | P1 | Confirmed | FX-03 | Open |
| OPS-02 | No CI; RLS suite validates a different schema than production and docs overstate it | MEDIUM | P1 | Confirmed | FX-02 | Open |
| OPS-04 | Backups, restore, monitoring and alerting are not evidenced | MEDIUM | P1 | Unverified | FX-03 | Open |
| SEC-01 | Public client-preview endpoint: weak throttling, non-atomic limit, link-holder can change plan state | MEDIUM | P1 | Confirmed | FX-04 | Open |
| DAT-01 | Cross-system Drive account creation without compensation | MEDIUM | P2 | Confirmed | FX-05 | Open |
| DAT-04 | Browser-direct INSERT policies lack data validation (leave dates/days, message metadata/length, expense fields) | MEDIUM | P2 | Confirmed | FX-02, FX-07 | Open |
| DAT-05 | employee.update rewrites roles and departments non-atomically; last-super-admin safeguards incomplete | MEDIUM | P2 | Confirmed | FX-01, FX-06 | Open |
| DAT-06 | Currency model is inconsistent: expenses default to USD, company and invoices use EGP, UI shows EGP | MEDIUM | P2 | Confirmed | FX-07 | Open |
| FUN-01 | Router has no render guard or module teardown: stale renders overwrite the page and hijack realtime | MEDIUM | P2 | Strong Evidence | FX-09 | Open |
| FUN-02 | Finance and reminder date logic mixes database UTC with Cairo business time | MEDIUM | P2 | Strong Evidence | FX-02, FX-10 | Open |
| PERF-01 | Notification fan-out is sequential/inline and costs several queries per recipient | MEDIUM | P2 | Potential | FX-11 | Open |
| PERF-02 | RLS predicates call SECURITY DEFINER functions per row; index support unverified | MEDIUM | P2 | Potential | FX-13 | Open |
| SEC-02 | Kite Drive tokens accepted in URL query strings | MEDIUM | P2 | Confirmed | FX-05 | Open |
| SEC-06 | Asset library paths are not bound to the uploader; storage read access derives from user-editable rows | MEDIUM | P2 | Strong Evidence | FX-02, FX-08 | Open |
| TST-01 | No automated tests for Edge Functions, PHP token verification, finance rounding in the browser, or UI flows | MEDIUM | P2 | Confirmed | FX-02 | Open |
| DAT-03 | Client deletion vs invoices and Drive: unverified cascade behaviour | LOW | P2 | Unverified | FX-12 | Open |
| SEC-07 | No rate limiting on authenticated actions that trigger push notifications | LOW | P2 | Confirmed | FX-04, FX-11 | Open |
| ARC-02 | God modules and no module contract in the browser | LOW | P3 | Confirmed | FX-09 | Open |
| DAT-02 | Legacy money columns silently zeroed by trigger | LOW | P3 | Confirmed | FX-15 | Open |
| DAT-07 | task.delete removes files and notifies before deleting, and hard-deletes history | LOW | P3 | Confirmed | FX-12 | Open |
| DAT-08 | Check-then-insert races without database constraints (DMs, rate limits, re-invite scan) | LOW | P3 | Confirmed | FX-06 | Open |
| DAT-09 | Storage objects are orphaned when rows are deleted by cascade (channels, employees, plans) | LOW | P3 | Confirmed | FX-12, FX-03 | Open |
| DOC-01 | docs/database.md lists 48 tables; migrations create 68 | LOW | P3 | Confirmed | FX-14 | Open |
| DOC-02 | Docs say 'only one trigger / no business logic in SQL'; code has 48 trigger instances and finance logic in SQL | LOW | P3 | Confirmed | FX-14 | Open |
| DOC-03 | Production checklist is stale and contradicts the code (migrations, buckets, RLS test, HR role limits) | LOW | P3 | Confirmed | FX-14 | Open |
| FUN-03 | task.update lets any participant change deadline, priority and project, including on finished tasks | LOW | P3 | Potential | FX-15 | Open |
| FUN-04 | due-reminders digest picks an arbitrary 'Next' item, includes stale items forever, and uses large IN lists | LOW | P3 | Confirmed | FX-15 | Open |
| FUN-05 | Content posts can be published or assigned without approval or role checks | LOW | P3 | Potential | FX-15 | Open |
| OPS-03 | Unbounded growth: Drive log/thumbnail cache, notifications, audit logs | LOW | P3 | Confirmed | FX-12, FX-03 | Open |
| PERF-03 | Many browser reads are unbounded or select('*') | LOW | P3 | Potential | FX-13 | Open |
| PERF-04 | Drive PHP does uploads, zip and thumbnails synchronously on shared hosting | LOW | P3 | Unverified | FX-13 | Open |
| SEC-03 | Client-triggered notification endpoints are replayable or unverified | LOW | P3 | Confirmed | FX-11 | Open |
| SEC-04 | Request body size guard reads whole body and counts characters | LOW | P3 | Confirmed | FX-15 | Open |
| SEC-05 | innerHTML surface relies on manual escaping | LOW | P3 | Potential | FX-09 | Open |
| SEC-08 | Employee directory exposes phone, joining date and employment type to all staff | LOW | P3 | Potential | FX-01 | Open |
| ARC-03 | Invitation token column unused; activation keyed by email only; legacy invoice columns kept | INFORMATIONAL | P3 | Confirmed | FX-15 | Open |

## Issue details

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

### OPS-01 — Scheduled jobs exist only in the Supabase dashboard; no heartbeat or alerting

| Field | Value |
|---|---|
| Category | Operations |
| Severity | MEDIUM |
| Priority | P1 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Major / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | OPS-01 |
| Affected module | Scheduled jobs |
| Affected files | `supabase/functions/due-reminders/index.ts:L1-L10`<br>`supabase/functions/retainer-billing/index.ts:L1-L12`<br>`docs/production-checklist.md (section 4b)` |
| Relevant functions | `due-reminders`, `retainer-billing` |
| Graph node IDs | `actor:cron`, `job:due-reminders`, `job:retainer-billing`, `fn:due-reminders`, `fn:retainer-billing` |
| Related workflows | Retainer billing (scheduled) |
| Related tables | `invoices`, `retainer_plans`, `notifications` |
| Fix package | FX-03 |
| Status | Open |

**Description.** Both daily jobs are scheduled from the dashboard and gated by CRON_SECRET. Nothing in the repo defines the schedule or records a last successful run. If the entry is deleted or the secret rotated, monthly retainer drafts and task digests stop silently; the functions are idempotent so re-runs are safe.

**Root cause.** Scheduling is configuration outside version control; no run ledger.

**Reproduction (safe).** Staging: remove the cron entry; observe no error anywhere and no new drafts next month.

**Impact.** Silent revenue-visible failure (missing retainer invoices) and silent loss of deadline reminders.

**Fix.** Migration creating cron.job entries via pg_cron + pg_net (or documented dashboard export) and a table job_runs(job, started_at, ok, detail) written by each function; a daily check function that alerts finance/admin if a job has not run within 26 h; commit the cron definitions.

**Acceptance criteria.** Dropping the cron triggers an alert within 26 h; job_runs shows one row per day; schedule is in git.

**Required tests.** Function test writing job_runs; SQL test of the staleness view.

**Verification method.** SELECT * FROM cron.job; SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20 (see VERIFICATION_PLAN).

**Why this classification.** Medium: silent-failure class with financial visibility; mitigated by idempotent design and manual 'retainer.run'.

---

### OPS-02 — No CI; RLS suite validates a different schema than production and docs overstate it

| Field | Value |
|---|---|
| Category | Operations |
| Severity | MEDIUM |
| Priority | P1 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Major / High / L |
| Evidence basis | Executed in this audit (in-process RLS suite) + source |
| Previous audit ID | OPS-02 |
| Affected module | Testing / delivery |
| Affected files | `supabase/tests/verify-rls.mjs:L23,L167,L260,L487`<br>`docs/production-checklist.md (section 5)`<br>`(absent) .github/` |
| Relevant functions | `verify-rls.mjs` |
| Graph node IDs | `ext:postgrest`, `sql:auth_is_owner`, `sql:auth_is_admin` |
| Related workflows | — |
| Related tables | `clients`, `invoices`, `assets`, `content_plans`, `client_drive_links` |
| Fix package | FX-02 |
| Status | Open |

**Description.** Observed: node verify-rls.mjs reports 153 passed, 0 failed. It applies migrations 001-005, 016 and 017 (plus seeds) but not 006-015, 018 or 019, so controls from 007 (assets), 009 (content plans), 012 (hardening), 015 (owner-only money, client scope) and 019 (drive links) are not exercised, and 017 runs without 015. The production checklist claims it 'applies all migrations' with 79 scenarios. No CI runs it.

**Root cause.** The harness was extended ad hoc per migration and is run manually.

**Reproduction (safe).** cd supabase/tests && npm install && node verify-rls.mjs; read the 'OK migrations/...' lines.

**Impact.** Policy regressions in the untested migrations ship unnoticed; false confidence from a green run.

**Fix.** Apply every migration 001-019 in order in the harness; add scenarios for 007/009/012/015/019 (e.g. asset path, owner-only money, client department scope, drive links no grants); add GitHub Actions running it on every PR; fail on any migration error; update the checklist counts.

**Acceptance criteria.** CI runs all 19 migrations and fails on any assertion; scenarios exist for each security migration; checklist matches reality.

**Required tests.** The harness itself plus a meta-check that every migration file is applied.

**Verification method.** CI log shows 19 'OK' migration lines.

**Why this classification.** Medium: it is the main safety net for the whole security model and is incomplete; observed result is runtime evidence.

---

### OPS-04 — Backups, restore, monitoring and alerting are not evidenced

| Field | Value |
|---|---|
| Category | Operations |
| Severity | MEDIUM |
| Priority | P1 |
| Confidence | Unverified |
| Impact / Likelihood / Effort | Major / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Operations |
| Affected files | `docs/production-checklist.md (sections 1, 6, all boxes unchecked)`<br>`(absent) monitoring/alert configuration` |
| Relevant functions | — |
| Graph node IDs | `ext:vercel`, `ext:hostinger`, `ext:supabase-auth`, `ext:postgrest` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-03 |
| Status | Open |

**Description.** The checklist requires daily backups with a tested restore, uptime checks, Edge Function error alerts and a key-rotation procedure, but no evidence exists in the repo that any are done; live state could not be inspected. Drive files on Hostinger have no documented backup.

**Root cause.** Operations are manual and undocumented.

**Reproduction (safe).** Review the Supabase, Vercel and Hostinger consoles.

**Impact.** Data loss or long outage without detection; Drive files unrecoverable.

**Fix.** Enable and test Supabase PITR/daily backup restore into a scratch project; schedule Hostinger backups of uploads/ and MySQL; uptime check on /login.html and each Edge Function health action; alert on 5xx rate and cron staleness (FX-03); write the rotation runbook for KITE_DRIVE_API_SECRET, CRON_SECRET, service_role.

**Acceptance criteria.** A documented restore drill succeeded within the last 90 days; alerts fire in a test; runbooks exist.

**Required tests.** Restore drill.

**Verification method.** Console evidence screenshots/exports (no secrets).

**Why this classification.** Medium: potentially severe but unverified; severity rests on it being absent.

---

### SEC-01 — Public client-preview endpoint: weak throttling, non-atomic limit, link-holder can change plan state

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P1 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-01 |
| Affected module | Content plans / client review |
| Affected files | `supabase/functions/client-preview/index.ts:L17,L87-L130`<br>`supabase/functions/content-plan/index.ts:L65-L74`<br>`supabase/config.toml:L69-L70` |
| Relevant functions | `client-preview (feedback, approve_all)`, `content-plan share.enable` |
| Graph node IDs | `fn:client-preview`, `fe:preview`, `tbl:content_plan_shares`, `tbl:content_feedback`, `tbl:content_plans`, `tbl:notifications` |
| Related workflows | Client content approval, Notifications and push |
| Related tables | `content_plan_shares`, `content_feedback`, `content_plans`, `notifications` |
| Fix package | FX-04 |
| Status | Open |

**Description.** The unauthenticated function limits feedback to 60/hour per plan using a count query followed by a separate insert. approve_all and change requests set plan status with no confirmation or idempotency. Every accepted call notifies all admins, the creator and the publisher, each with push. Share links default to never expiring (days=0 in content-plan) and the token is returned to any department member who can edit the plan.

**Root cause.** The only abuse control is a per-plan counter that is read and written in two steps; the share token is a bearer credential with no expiry, rotation or per-client throttle.

**Reproduction (safe).** On a test project: create a plan, enable sharing, then POST {action:'approve_all'} and 70 'feedback' calls (use a script against a non-production project). Observe status flips, >60 rows when parallel, and one notification per admin per call.

**Impact.** A forwarded or leaked link lets a third party approve or reject a plan and generate up to 60 x (admins+2) notifications and pushes per hour per plan. Concurrent requests exceed the limit. No data exfiltration: 'get' returns presentation fields and 1-hour signed image URLs.

**Fix.** 1) Add table content_feedback_rate(plan_id, window_start, n) updated with INSERT ... ON CONFLICT DO UPDATE ... RETURNING n so the limit is atomic; add a per-IP key (x-forwarded-for hash). 2) approve_all becomes a no-op when status is already approved. 3) share.enable default expiry 30 days; regenerate token on staff request and when the creator leaves. 4) Coalesce feedback notifications (one per plan per 10 minutes). 5) Staff UI shows link expiry and a Revoke button.

**Acceptance criteria.** Parallel burst of 200 calls yields at most the configured number of rows; second approve_all returns 200 without notifying; link with expiry returns 410 after expiry; revoke returns 404.

**Required tests.** Deno test with 50 concurrent requests; SQL test for the atomic counter; test that expired/disabled tokens return 410/404; notification-count assertion.

**Verification method.** Run the burst test against a staging project; confirm audit_logs and notifications counts equal the limit.

**Why this classification.** Medium: public write path with real (internal) notification amplification and state change, but no confidentiality loss and requires possession of a 192-bit token.

---

### DAT-01 — Cross-system Drive account creation without compensation

| Field | Value |
|---|---|
| Category | Data |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | DAT-01 |
| Affected module | Kite Drive |
| Affected files | `supabase/functions/kite-drive/index.ts:L177-L205`<br>`integrations/kite-drive/api/index.php (create_client)` |
| Relevant functions | `kite-drive link.create / link.set` |
| Graph node IDs | `fn:kite-drive`, `php:index`, `tbl:client_drive_links` |
| Related workflows | Kite Drive file access |
| Related tables | `client_drive_links`, `clients` |
| Fix package | FX-05 |
| Status | Open |

**Description.** link.create creates the Drive account over HTTP and then upserts client_drive_links. If the upsert fails the Drive account and password hash are orphaned; a retry hits 409 on the Drive email. link.set upserts, silently re-pointing an already linked client.

**Root cause.** Two systems are written in sequence with no compensating action or idempotency key.

**Reproduction (safe).** Staging: make the second write fail (revoke INSERT for the service role on client_drive_links) and call link.create; the Drive user remains.

**Impact.** Orphan Drive accounts, confusing retries, possible stale credentials.

**Fix.** Add Drive action delete_client(id) (admin token) and call it in a catch block; make link.create idempotent by looking up the Drive client by email first; make link.set refuse when a link exists unless replace=true.

**Acceptance criteria.** Forced failure leaves no Drive user; repeating link.create returns the same link; link.set on an existing link returns 409 without replace.

**Required tests.** Edge test with a stubbed Drive API returning success then DB failure; PHP test for delete_client scoping.

**Verification method.** Run the failure injection in staging.

**Why this classification.** Medium: partial-operation defect with limited blast radius; admin-only trigger.

---

### DAT-04 — Browser-direct INSERT policies lack data validation (leave dates/days, message metadata/length, expense fields)

| Field | Value |
|---|---|
| Category | Data |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | HR / chat / finance |
| Affected files | `supabase/migrations/001_initial_schema.sql (leave_requests, expenses, messages)`<br>`supabase/migrations/002_rls_policies.sql (leave_requests_insert, expenses_insert)`<br>`supabase/migrations/016_chat_v2_private_and_media.sql:L64-L68`<br>`js/modules/hr/hr.js:L538-L552`<br>`js/modules/finance/finance.js:L318-L326`<br>`supabase/functions/chat/index.ts:L222-L238,L260-L262` |
| Relevant functions | `leave_requests_insert`, `expenses_insert`, `messages_insert`, `mediaMetadata` |
| Graph node IDs | `fe:hr`, `fe:finance`, `fn:chat`, `tbl:leave_requests`, `tbl:expenses`, `tbl:messages` |
| Related workflows | Expense and leave approval |
| Related tables | `leave_requests`, `expenses`, `messages`, `attendance_records` |
| Fix package | FX-02, FX-07 |
| Status | Open |

**Description.** Rules exist in the UI or Edge Functions but not in the database for rows the browser can insert directly. leave_requests: no CHECK end_date >= start_date and total_days is client-supplied (UI uses ceil days including weekends); approvers see the unverified numbers in notifications. messages: policy allows types voice/image/file/call with arbitrary jsonb metadata and unlimited content length when inserted directly, bypassing the chat function's path/MIME/size validation and notifications. expenses: currency is free text, receipt_path is unconstrained.

**Root cause.** Two write paths (RLS insert vs Edge Function) enforce different rules; only the function validates.

**Reproduction (safe).** With a normal user session use the Supabase client to insert a leave request with end before start and total_days 1000, and a 5 MB 'call' message.

**Impact.** Wrong leave balances/approvals, forged call cards, oversized rows, inconsistent expense data.

**Fix.** Migration: CHECK (end_date >= start_date); trigger computing total_days server-side from dates minus configured weekends/holidays; CHECK on messages (char_length(content) <= 4000; message_type 'call' and media types only via service role - split insert policy to text/task_handoff); constrain metadata size (pg_column_size < 4kB); expenses.currency CHECK (char_length=3) and default from finance_settings; receipt_path must start with submitted_by prefix. Mark constraints NOT VALID, clean data, then VALIDATE.

**Acceptance criteria.** Each invalid insert is rejected by the database; valid UI flows still work; suite covers each rule.

**Required tests.** RLS/SQL scenarios for each rejected case; UI regression for leave and expense forms.

**Verification method.** SELECT count(*) FROM leave_requests WHERE end_date < start_date;

**Why this classification.** Medium: confirmed integrity gap affecting HR and finance data; approvers can catch most cases manually.

---

### DAT-05 — employee.update rewrites roles and departments non-atomically; last-super-admin safeguards incomplete

| Field | Value |
|---|---|
| Category | Data |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Low / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Employee administration |
| Affected files | `supabase/functions/workflow/index.ts:L473-L476,L480-L505`<br>`supabase/functions/invite-employee/index.ts:L26-L44` |
| Relevant functions | `employeeUpdate`, `invite-employee delete` |
| Graph node IDs | `fn:workflow`, `fn:invite-employee`, `tbl:user_roles`, `tbl:user_departments`, `tbl:profiles` |
| Related workflows | Employee invitation to activation |
| Related tables | `user_roles`, `user_departments`, `profiles`, `roles` |
| Fix package | FX-01, FX-06 |
| Status | Open |

**Description.** A role change does DELETE FROM user_roles WHERE user_id then INSERT as two separate requests; if the insert fails the user keeps no role and is locked out (and a multi-role user loses all roles). Department changes delete and re-insert user_departments the same way. The 'never remove the last super admin' check counts rows before the delete (race), is not applied to deactivation/ban, and invite-employee delete has no such check.

**Root cause.** Multi-statement changes executed from the Edge Function without a transaction.

**Reproduction (safe).** Staging: make the insert fail (invalid role id after delete is prevented, so revoke INSERT temporarily) and observe zero roles.

**Impact.** User lockout or privilege loss mid-change; possibility of removing the only super admin.

**Fix.** Create SQL function admin_set_user_roles(actor, user, role_ids[]) and admin_set_user_departments(...) executing delete+insert in one transaction with FOR UPDATE on the user row, enforcing the last-super-admin rule against every path (role change, deactivate, delete); Edge calls the function.

**Acceptance criteria.** Failure injection leaves previous roles intact; concurrent removal of two super admins leaves one; deactivating the last super admin is rejected.

**Required tests.** SQL tests with failure injection and two concurrent sessions.

**Verification method.** Run tests on staging.

**Why this classification.** Medium: partial-failure and race on the most sensitive records; low likelihood, moderate impact.

---

### DAT-06 — Currency model is inconsistent: expenses default to USD, company and invoices use EGP, UI shows EGP

| Field | Value |
|---|---|
| Category | Data |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / High / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Finance |
| Affected files | `supabase/migrations/001_initial_schema.sql (expenses.currency DEFAULT 'USD')`<br>`supabase/seed.sql:L53`<br>`supabase/migrations/017_finance_invoicing.sql:L50 (finance_settings.currency EGP)`<br>`js/modules/finance/finance.js:L215,L318-L326`<br>`js/utils/helpers.js:L89`<br>`supabase/functions/workflow/index.ts:L610` |
| Relevant functions | `expenseSubmitted`, `formatCurrency` |
| Graph node IDs | `fe:finance`, `fn:workflow`, `tbl:expenses`, `tbl:finance_settings`, `tbl:invoices` |
| Related workflows | Expense and leave approval, Invoice lifecycle (finance) |
| Related tables | `expenses`, `finance_settings`, `invoices`, `budgets`, `money_figures` |
| Fix package | FX-07 |
| Status | Open |

**Description.** The expense form has no currency field, so every claim stores currency='USD' (DB default). The list renders amounts with formatCurrency(e.amount) which defaults to EGP, while the approver notification prints the stored currency ('USD 500'). finance_settings and invoices use EGP; seed.sql company info says USD; budgets and money_figures carry no currency.

**Root cause.** Currency was never modelled as a system-wide setting.

**Reproduction (safe).** Create an expense of 500 and read the row and the notification text.

**Impact.** Wrong or ambiguous amounts in reports and approvals; data that cannot be aggregated safely.

**Fix.** Decide the company currency; set expenses.currency default from finance_settings via trigger; add currency selection only if multi-currency is required; backfill existing rows after confirming the intended currency; make UI use the row currency; add CHECK for ISO-4217 length.

**Acceptance criteria.** New expenses store EGP (or chosen) and display consistently in list, notification and reports; no row has a mismatched currency.

**Required tests.** SQL test for default; UI test; notification text test.

**Verification method.** SELECT currency, count(*) FROM expenses GROUP BY 1;

**Why this classification.** Medium: financial data mislabeling; likelihood high because it affects every claim; live data unverified.

---

### FUN-01 — Router has no render guard or module teardown: stale renders overwrite the page and hijack realtime

| Field | Value |
|---|---|
| Category | Functional |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Frontend shell |
| Affected files | `js/router.js:L34-L90`<br>`js/services/realtime-service.js:L25-L69`<br>`js/modules/chat/chat.js:L62,L325,L449-L457` |
| Relevant functions | `handleHashChange`, `Realtime.watch/clear`, `ChatModule.render/teardownRealtime` |
| Graph node IDs | `fe:shell`, `fe:svc:realtime-service`, `fe:chat`, `ext:realtime` |
| Related workflows | Notifications and push |
| Related tables | `messages`, `conversations`, `tasks` |
| Fix package | FX-09 |
| Status | Open |

**Description.** handleHashChange awaits routeConfig.render() into one shared container with no navigation token. A slow render from route A finishing after the user opened route B overwrites B's DOM. Realtime is a singleton: A's late call to Realtime.watch() calls clear() and replaces B's watcher, so B stops live updates and A's reload then redraws into B's container on every change. There is no unmount hook: ChatModule's postgres_changes and typing channels are torn down only when chat renders again, so they keep running after leaving chat.

**Root cause.** No module lifecycle contract (mount/unmount, cancellation).

**Reproduction (safe).** Throttle network, click Chat then Tasks quickly; or open Chat, navigate away and watch websocket frames.

**Impact.** Wrong content shown, missing live updates, wasted connections and background refreshes.

**Fix.** Router keeps a renderId; after each await check it still equals the current id and drop stale output; call module.unmount() on navigation; modules register teardown; Realtime.watch takes an owner token and ignores stale owners; ChatModule implements unmount() calling teardownRealtime().

**Acceptance criteria.** Rapid navigation test ends on the last route with correct content and exactly one active realtime channel; leaving chat removes its channels.

**Required tests.** Playwright test with delayed network; unit test for renderId logic.

**Verification method.** Count supabase channels via devtools before/after navigation.

**Why this classification.** Medium: user-visible incorrect behaviour; no data loss.

---

### FUN-02 — Finance and reminder date logic mixes database UTC with Cairo business time

| Field | Value |
|---|---|
| Category | Functional |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Finance / scheduling |
| Affected files | `supabase/migrations/017_finance_invoicing.sql:L320-L322,L538,L574,L609`<br>`supabase/functions/due-reminders/index.ts:L26-L30`<br>`supabase/functions/retainer-billing/index.ts` |
| Relevant functions | `fin_payment_add`, `fin_refresh_status`, `fin_mark_overdue`, `fin_invoice_issue` |
| Graph node IDs | `sql:fin_payment_add`, `sql:fin_refresh_status`, `sql:fin_mark_overdue`, `sql:fin_invoice_issue`, `fn:due-reminders`, `fn:retainer-billing` |
| Related workflows | Invoice lifecycle (finance), Retainer billing (scheduled) |
| Related tables | `invoices`, `invoice_payments` |
| Fix package | FX-02, FX-10 |
| Status | Open |

**Description.** Payment validation rejects paid_on > current_date and overdue/numbering logic uses current_date, evaluated in the database session time zone (Supabase default UTC). Reminder and retainer functions use REMINDER_TZ (Africa/Cairo). Between 00:00 and 02:00/03:00 Cairo the local date is ahead of UTC, so a payment dated today is rejected as 'in the future'; invoices become overdue and numbers take the year from UTC.

**Root cause.** Business time zone not configured in SQL.

**Reproduction (safe).** Scratch DB with SET timezone='UTC': call fin_payment_add with Cairo's date during the first hours after local midnight.

**Impact.** Blocked payment entry for a few hours daily; overdue transitions and year boundaries off by hours.

**Fix.** Add finance_settings.timezone (default Africa/Cairo) and helper fin_today() = (now() AT TIME ZONE tz)::date; replace current_date in fin_* functions; align cron times.

**Acceptance criteria.** Test sets session time to 23:30 UTC and passes with Cairo date; overdue boundary follows Cairo.

**Required tests.** SQL tests with fixed now().

**Verification method.** SHOW timezone on live; run the boundary test.

**Why this classification.** Medium: recurring functional blocker in finance entry; likelihood depends on live timezone (unverified).

---

### PERF-01 — Notification fan-out is sequential/inline and costs several queries per recipient

| Field | Value |
|---|---|
| Category | Performance |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Notifications |
| Affected files | `supabase/functions/_shared/auth.ts (notify)`<br>`supabase/functions/_shared/push.ts:L55-L100`<br>`supabase/functions/broadcast/index.ts:L86-L90`<br>`supabase/functions/workflow/index.ts:L229-L234,L363-L368` |
| Relevant functions | `notify`, `sendPush` |
| Graph node IDs | `shared:auth`, `shared:push`, `fn:broadcast`, `fn:workflow`, `tbl:notifications`, `tbl:push_subscriptions` |
| Related workflows | Notifications and push, Client content approval |
| Related tables | `notifications`, `push_subscriptions` |
| Fix package | FX-11 |
| Status | Open |

**Description.** notify() performs an insert, then sendPush does a subscriptions query, an unread-count query and one HTTPS push per device, awaited inside the request. Task events loop sequentially; broadcast batches 10 in parallel (at least 3 queries per user). Large audiences risk Edge time limits and partial delivery (see DAT-08). No measurements exist.

**Root cause.** Synchronous per-recipient delivery.

**Reproduction (safe).** Broadcast to a staging project with 200 users and time it.

**Impact.** Slow actions, timeouts, partial delivery.

**Fix.** Bulk insert notifications in one statement; fetch subscriptions for all recipients in one query; send pushes via a queue/outbox processed by a worker function; cap per-request recipients.

**Acceptance criteria.** Broadcast to 200 users completes under 5 s with one insert statement; failures retry.

**Required tests.** Load test in staging.

**Verification method.** Timing before/after.

**Why this classification.** Medium/Potential: design risk without measurements.

---

### PERF-02 — RLS predicates call SECURITY DEFINER functions per row; index support unverified

| Field | Value |
|---|---|
| Category | Performance |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Database |
| Affected files | `supabase/migrations/002_rls_policies.sql:L132-L148,L527-L528`<br>`supabase/migrations/015_owner_only_money_and_client_scope.sql:L38-L53` |
| Relevant functions | `auth_can_view_task`, `auth_can_see_client`, `auth_can_view_conversation` |
| Graph node IDs | `sql:auth_can_view_task`, `sql:auth_can_see_client`, `ext:postgrest`, `tbl:tasks`, `tbl:clients` |
| Related workflows | Task status change |
| Related tables | `tasks`, `clients`, `messages`, `task_assignees`, `user_departments` |
| Fix package | FX-13 |
| Status | Open |

**Description.** tasks_select is USING (auth_can_view_task(id)); the function is STABLE SECURITY DEFINER and cannot be inlined, so non-admin queries evaluate EXISTS subqueries per candidate row. Efficiency depends on indexes on task_assignees(task_id,user_id), user_departments(user_id), tasks(assigned_to), tasks(created_by) which were not verified.

**Root cause.** Row-level function-based policies.

**Reproduction (safe).** EXPLAIN ANALYZE SELECT * FROM tasks as a non-admin on a populated copy.

**Impact.** Slow list queries as tasks and messages grow.

**Fix.** Capture baselines with EXPLAIN (ANALYZE, BUFFERS); add missing indexes; rewrite hot policies with EXISTS subqueries or a membership materialization; consider SELECT ... WHERE assigned_to = auth.uid() fast paths.

**Acceptance criteria.** P95 for task list and chat history queries within agreed budget at 10x current rows.

**Required tests.** Load test with seeded volume.

**Verification method.** pg_stat_statements top queries (VERIFICATION_PLAN).

**Why this classification.** Medium/Potential: structural risk, not yet measured.

---

### SEC-02 — Kite Drive tokens accepted in URL query strings

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-02 |
| Affected module | Kite Drive |
| Affected files | `integrations/kite-drive/api/index.php:L447-L449`<br>`js/modules/clients/drive-panel.js:L164,L263,L598`<br>`supabase/functions/kite-drive/index.ts:L24-L33` |
| Relevant functions | `PHP verify_token/query token path`, `DrivePanel url builders` |
| Graph node IDs | `php:index`, `fn:kite-drive`, `fe:clients`, `ext:hostinger` |
| Related workflows | Kite Drive file access |
| Related tables | `client_drive_links` |
| Fix package | FX-05 |
| Status | Open |

**Description.** For download, view, thumb, zip and logo the HMAC token is read from ?token=. Tokens live 120-600 s and are scoped, but they appear in Hostinger access logs, browser history and any proxy. A 'view' token exposes every file of that client for up to 10 minutes.

**Root cause.** <img> and navigation requests cannot send headers, so the design put the token in the URL.

**Reproduction (safe).** Open a client's files in a test environment and inspect network requests and the Hostinger access log for token= values.

**Impact.** Anyone with log access within the token lifetime can read that client's files. Limited by short TTL and scope.

**Fix.** Exchange the token once for an HttpOnly, SameSite=None; Secure cookie scoped to /api/ (PHP sets it on a header-authenticated 'session' action); read file actions from the cookie. Alternative: single-use per-file URLs (nonce stored 60 s). Add Referrer-Policy: no-referrer and strip token from access logs. Deploy order: PHP accepts both, then SPA switches, then remove query path.

**Acceptance criteria.** No request URL contains token=; replayed cookie after 10 minutes returns 401; cross-client file access returns 403.

**Required tests.** PHP test vectors for cookie auth, expiry and cid binding; browser E2E for preview/download.

**Verification method.** Grep access log for 'token=' after deploy: zero matches.

**Why this classification.** Medium: credential exposure channel with short validity and scope; requires log or history access.

---

### SEC-06 — Asset library paths are not bound to the uploader; storage read access derives from user-editable rows

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Asset library / storage |
| Affected files | `supabase/migrations/007_assets_and_realtime.sql:L24-L83`<br>`supabase/migrations/012_security_hardening.sql:L33-L55 (same class fixed for content assets)` |
| Relevant functions | `assets_insert / assets_update policies`, `studio_assets_read storage policy` |
| Graph node IDs | `tbl:assets`, `bkt:studio-assets`, `fe:documents`, `ext:postgrest` |
| Related workflows | — |
| Related tables | `assets`, `content_post_assets` |
| Fix package | FX-02, FX-08 |
| Status | Open |

**Description.** studio_assets_read lets any authenticated user read an object in studio-assets if an assets row with that storage_path is visible to them. assets_insert/assets_update only require uploaded_by = auth.uid(); storage_path is unconstrained (the comment says '<uploader id>/...' but nothing enforces it). A user who learns another object's path can insert their own assets row pointing at it and then read the file; also an existence oracle via the UNIQUE violation. Migration 012 closed exactly this class for content_post_assets only.

**Root cause.** Authorization of a storage object is delegated to a row the caller can create.

**Reproduction (safe).** Staging: user A creates a private asset; user B inserts an assets row with A's storage_path and requests a signed URL.

**Impact.** Revocation bypass and cross-user file access when a path is known (paths are random, so needs a leak: past access, logs, shared screenshots).

**Fix.** Migration: CHECK (storage_path LIKE uploaded_by::text || '/%') NOT VALID then VALIDATE; update assets_insert/assets_update WITH CHECK to require the prefix; trigger forbidding storage_path changes on UPDATE; add the scenario to the RLS suite.

**Acceptance criteria.** Insert/update with a foreign prefix fails; suite scenario passes; existing rows validated or listed for cleanup.

**Required tests.** RLS scenario: foreign-path insert denied; update of storage_path denied.

**Verification method.** SELECT count(*) FROM assets WHERE split_part(storage_path,'/',1) <> uploaded_by::text;

**Why this classification.** Medium: defence-in-depth gap of a class the team already judged worth fixing; exploitation needs path knowledge.

---

### TST-01 — No automated tests for Edge Functions, PHP token verification, finance rounding in the browser, or UI flows

| Field | Value |
|---|---|
| Category | Testing |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Major / High / L |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Testing |
| Affected files | `(absent) *.test.ts / php tests / playwright config` |
| Relevant functions | — |
| Graph node IDs | `shared:auth`, `fn:workflow`, `fn:finance`, `fn:kite-drive`, `php:index`, `fe:finance` |
| Related workflows | Task status change, Invoice lifecycle (finance), Kite Drive file access, Employee invitation to activation |
| Related tables | — |
| Fix package | FX-02 |
| Status | Open |

**Description.** The only tests are the SQL/RLS suite. There are none for getCaller's role/status matrix, workflow state machine, finance function error mapping, kite-drive token signing vs PHP verification (cross-language), upload blocklist/zip handling, or any UI flow. No concurrency tests besides SQL.

**Root cause.** Tests were added only for the database layer.

**Reproduction (safe).** Search the repo.

**Impact.** Regressions in authorization and money paths are caught only manually.

**Fix.** Add deno test for _shared and each function with a mocked service client; shared token vectors (TS signs, PHP verifies); Playwright smoke: login, create task, change status, invoice issue; run in CI (FX-02).

**Acceptance criteria.** CI runs unit, interop and smoke tests; coverage report published.

**Required tests.** As listed.

**Verification method.** CI green.

**Why this classification.** Medium: broad quality gap in security- and money-critical layers.

---

### DAT-03 — Client deletion vs invoices and Drive: unverified cascade behaviour

| Field | Value |
|---|---|
| Category | Data |
| Severity | LOW |
| Priority | P2 |
| Confidence | Unverified |
| Impact / Likelihood / Effort | Moderate / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | DAT-03 |
| Affected module | Clients / finance |
| Affected files | `supabase/migrations/002_rls_policies.sql:L203,L345-L347`<br>`supabase/migrations/017_finance_invoicing.sql:L95,L345-L354` |
| Relevant functions | `clients_delete policy`, `fin_invoice_guard` |
| Graph node IDs | `tbl:clients`, `tbl:invoices`, `tbl:client_billing`, `tbl:client_drive_links` |
| Related workflows | Invoice lifecycle (finance), Kite Drive file access |
| Related tables | `clients`, `invoices`, `client_billing`, `retainer_plans`, `client_drive_links` |
| Fix package | FX-12 |
| Status | Open |

**Description.** Admins can DELETE clients from the browser. invoices.client_id is ON DELETE SET NULL (001) but fin_invoice_guard rejects client_id changes on issued invoices, retainer_plans.client_id is RESTRICT, client_billing and drive links cascade, and the Drive account/files remain. The net result was not executed.

**Root cause.** Conflicting delete rules across migrations.

**Reproduction (safe).** Scratch DB: create client with an issued invoice and retainer plan, delete the client, observe error vs orphan.

**Impact.** Either a blocked delete (acceptable) or orphaned invoices and Drive data.

**Fix.** Replace hard delete with archive (clients.archived_at) and block delete when invoices/plans exist; add FK RESTRICT on invoices.client_id; document Drive account handling.

**Acceptance criteria.** Deleting a client with invoices fails with a clear message; archived clients are hidden.

**Required tests.** SQL test for each dependent type.

**Verification method.** Run the scratch-DB scenario.

**Why this classification.** Low pending verification; priority P2 because the outcome touches financial records.

---

### SEC-07 — No rate limiting on authenticated actions that trigger push notifications

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Chat / notifications |
| Affected files | `supabase/functions/chat/index.ts:L248-L273,L326-L350`<br>`supabase/functions/workflow/index.ts:L543-L576`<br>`supabase/functions/_shared/auth.ts (notify)` |
| Relevant functions | `messageSend`, `callStart`, `taskComment` |
| Graph node IDs | `fn:chat`, `fn:workflow`, `shared:auth`, `shared:push`, `tbl:notifications` |
| Related workflows | Notifications and push |
| Related tables | `notifications`, `messages`, `conversation_members` |
| Fix package | FX-04, FX-11 |
| Status | Open |

**Description.** Only broadcast (10/hour) and client-preview are throttled. Any staff member can call chat call.start in a public channel repeatedly: each call inserts a call message and sends an urgent requireInteraction push to every member. message.send, task.comment and task.file_added have no limits.

**Root cause.** No shared limiter in the Edge layer.

**Reproduction (safe).** Staging: loop call.start 50 times in a channel with several members.

**Impact.** Harassment/denial of attention by a malicious or compromised staff account; push-service quota consumption.

**Fix.** Add a rate_limits table with atomic upsert (key, window, n) and helper rateLimit(caller, action, max, windowSec) in _shared; apply to message.send (30/min), call.start (3/min per conversation), comments, push.test.

**Acceptance criteria.** Exceeding the limit returns 429; limits covered by tests.

**Required tests.** Edge tests with burst calls.

**Verification method.** Burst test in staging.

**Why this classification.** Low: internal users only; real but limited impact.

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

### DAT-02 — Legacy money columns silently zeroed by trigger

| Field | Value |
|---|---|
| Category | Data |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | DAT-02 |
| Affected module | Finance / CRM |
| Affected files | `supabase/migrations/015_owner_only_money_and_client_scope.sql (blank_money_columns)` |
| Relevant functions | `blank_money_columns()` |
| Graph node IDs | `sql:blank_money_columns`, `tbl:money_figures`, `tbl:clients` |
| Related workflows | — |
| Related tables | `money_figures`, `clients`, `projects`, `campaigns`, `departments`, `leads`, `opportunities` |
| Fix package | FX-15 |
| Status | Open |

**Description.** A BEFORE INSERT OR UPDATE trigger on six tables sets budget/value/monthly_budget to NULL/0, so any writer silently loses values; real figures live in money_figures.

**Root cause.** Secrecy of money was implemented by blanking legacy columns instead of removing them.

**Reproduction (safe).** UPDATE projects SET budget=500 in a scratch DB and read it back: 0.

**Impact.** Confusing data loss for any code still writing these columns.

**Fix.** After confirming no reader (grep and query log), drop the columns in a migration; until then raise an exception instead of silently zeroing.

**Acceptance criteria.** Columns removed; no code references them; writes to them fail loudly.

**Required tests.** SQL test that the columns do not exist.

**Verification method.** information_schema.columns check.

**Why this classification.** Low: correct for secrecy, only surprising to developers.

---

### DAT-07 — task.delete removes files and notifies before deleting, and hard-deletes history

| Field | Value |
|---|---|
| Category | Data |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Tasks |
| Affected files | `supabase/functions/workflow/index.ts:L376-L409` |
| Relevant functions | `taskDelete` |
| Graph node IDs | `fn:workflow`, `tbl:tasks`, `tbl:task_attachments`, `tbl:task_activity_logs`, `bkt:task-attachments` |
| Related workflows | Task status change |
| Related tables | `tasks`, `task_attachments`, `task_activity_logs`, `task_comments`, `task_time_entries`, `invoices` |
| Fix package | FX-12 |
| Status | Open |

**Description.** The function notifies participants, removes storage objects, then deletes the task. A failure of the final delete leaves attachment rows whose files are gone and recipients told of a deletion that did not happen. The delete cascades comments, time entries, checklists and the task activity log (audit_logs keeps one TASK_DELETED row); invoices.task_id is set null.

**Root cause.** Ordering of side effects before the commit point; hard delete instead of archive.

**Reproduction (safe).** Force the DELETE to fail (FK or revoked privilege) in staging.

**Impact.** Inconsistent attachments, loss of per-task history.

**Fix.** Delete the row first, then enqueue storage removal and notifications (outbox); prefer soft delete (tasks.deleted_at) for non-draft tasks; keep activity log.

**Acceptance criteria.** Failure injection leaves files and notifications untouched.

**Required tests.** Edge test with failing delete.

**Verification method.** Staging test.

**Why this classification.** Low: rare failure, limited data.

---

### DAT-08 — Check-then-insert races without database constraints (DMs, rate limits, re-invite scan)

| Field | Value |
|---|---|
| Category | Data |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Chat / broadcast / invitations |
| Affected files | `supabase/functions/chat/index.ts:L164-L172,L313-L322`<br>`supabase/functions/broadcast/index.ts:L47-L95`<br>`supabase/functions/invite-employee/index.ts:L84-L89` |
| Relevant functions | `dmCreate`, `reactionToggle`, `broadcast send`, `re-invite` |
| Graph node IDs | `fn:chat`, `fn:broadcast`, `fn:invite-employee`, `tbl:conversations`, `tbl:broadcasts` |
| Related workflows | Employee invitation to activation, Notifications and push |
| Related tables | `conversations`, `conversation_members`, `broadcasts`, `message_reactions` |
| Fix package | FX-06 |
| Status | Open |

**Description.** dm.create looks up an existing pair then inserts, with no unique pair key: concurrent calls create duplicate DMs. broadcast counts previous broadcasts, sends all notifications, and only then inserts the history row, so concurrent calls bypass the limit, a failure after sending retries duplicates, and a failed history insert disables rate limiting; a large audience can exceed the function time limit mid-send. invite-employee scans only the first 1000 auth users for a stale account.

**Root cause.** Application-level uniqueness and ordering.

**Reproduction (safe).** Fire two parallel dm.create for the same pair.

**Impact.** Duplicate conversations, duplicated announcements, stuck re-invites beyond 1000 users.

**Fix.** Add conversations.pair_key (sorted user ids) unique for direct; insert broadcast row first (status 'sending') and update after; page through listUsers or look up by email via admin API; make reaction toggle an upsert/delete in one SQL statement.

**Acceptance criteria.** Parallel calls create one DM and one broadcast row.

**Required tests.** Concurrency tests.

**Verification method.** Run parallel calls in staging.

**Why this classification.** Low: low likelihood, small blast radius.

---

### DAT-09 — Storage objects are orphaned when rows are deleted by cascade (channels, employees, plans)

| Field | Value |
|---|---|
| Category | Data |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Storage lifecycle |
| Affected files | `supabase/functions/chat/index.ts:L147-L156`<br>`supabase/functions/invite-employee/index.ts:L36-L41`<br>`supabase/migrations/007_assets_and_realtime.sql (assets.uploaded_by CASCADE)`<br>`supabase/migrations/009_content_plans.sql:L175-L184` |
| Relevant functions | `channelDelete`, `employee delete` |
| Graph node IDs | `fn:chat`, `fn:invite-employee`, `bkt:chat-media`, `bkt:studio-assets`, `tbl:assets` |
| Related workflows | — |
| Related tables | `conversations`, `messages`, `assets`, `content_post_assets`, `message_attachments` |
| Fix package | FX-12, FX-03 |
| Status | Open |

**Description.** channel.delete cascades messages but never removes the conversation's chat-media prefix; deleting an employee cascades their assets rows while the files stay in studio-assets; plan deletion relies on the browser to remove files. Only task delete and single message delete clean storage.

**Root cause.** Cleanup is ad hoc per code path.

**Reproduction (safe).** Delete a channel with media and list the bucket prefix.

**Impact.** Storage growth and retention of personal/client files after deletion.

**Fix.** Nightly job comparing storage.objects to referencing rows (and a delete trigger/outbox that removes the prefix); channel and employee delete enqueue prefix removal.

**Acceptance criteria.** Orphan query returns zero after job; deleting a channel removes its media.

**Required tests.** Integration test with a stubbed storage client.

**Verification method.** Orphan SQL in VERIFICATION_PLAN.

**Why this classification.** Low: growth and hygiene; no exposure by itself.

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

### FUN-03 — task.update lets any participant change deadline, priority and project, including on finished tasks

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Tasks |
| Affected files | `supabase/functions/workflow/index.ts:L328-L372` |
| Relevant functions | `taskUpdate` |
| Graph node IDs | `fn:workflow`, `fe:tasks`, `tbl:tasks` |
| Related workflows | Task status change |
| Related tables | `tasks` |
| Fix package | FX-15 |
| Status | Open |

**Description.** Authorization is reviewer OR participant. An assignee can push the due date, lower priority or move the task to another visible project, and edits are allowed in any status (including completed/cancelled); updates are unconditional (lost updates). Whether this is intended needs the specification.

**Root cause.** Single edit permission for all fields.

**Reproduction (safe).** As assignee edit dueDate.

**Impact.** Silent deadline slippage; audit trail exists.

**Fix.** Field-level rules: only reviewers change dueDate/priority/project; block edits when status in completed/cancelled unless admin; use updated_at optimistic concurrency.

**Acceptance criteria.** Rules implemented per spec; tests per role/status.

**Required tests.** Edge tests per role and status.

**Verification method.** Run tests.

**Why this classification.** Low/Potential: rule depends on the missing spec.

---

### FUN-04 — due-reminders digest picks an arbitrary 'Next' item, includes stale items forever, and uses large IN lists

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Scheduled reminders |
| Affected files | `supabase/functions/due-reminders/index.ts:L36-L80,L82-L121` |
| Relevant functions | `due-reminders handler` |
| Graph node IDs | `fn:due-reminders`, `job:due-reminders`, `tbl:tasks`, `tbl:content_posts` |
| Related workflows | Notifications and push |
| Related tables | `tasks`, `content_posts`, `notifications` |
| Fix package | FX-15 |
| Status | Open |

**Description.** The task query has no ORDER BY, so 'Next:' shows whichever overdue task came first, not the earliest due. Tasks and posts overdue for months are counted every day. profiles lookups use .in('id', [all ids]) which grows the request URL; beyond a few hundred users it can fail and the digest is silently skipped. Dedupe is read-then-insert (race only if run concurrently).

**Root cause.** Simple implementation without ordering or batching.

**Reproduction (safe).** Create two overdue tasks and run the function.

**Impact.** Misleading reminders, noise, scale limit.

**Fix.** ORDER BY due_date; cap digest to tasks overdue < 30 days or show count only; chunk IN lists (200); store a per-day dedupe key.

**Acceptance criteria.** Digest names the earliest due task; chunking covers 1000 users.

**Required tests.** Function test with fixtures.

**Verification method.** Run against staging data.

**Why this classification.** Low: quality issue.

---

### FUN-05 — Content posts can be published or assigned without approval or role checks

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Content plans |
| Affected files | `supabase/functions/content-plan/index.ts:L80-L99,L115-L132` |
| Relevant functions | `post.assign`, `post.publish` |
| Graph node IDs | `fn:content-plan`, `tbl:content_posts` |
| Related workflows | Client content approval |
| Related tables | `content_posts`, `content_plans` |
| Fix package | FX-15 |
| Status | Open |

**Description.** post.publish sets status 'published' for any editor or assigned publisher regardless of plan status (client approval not required) and post.assign accepts any active profile, including one holding only the client role. The business rule is not documented.

**Root cause.** No status/approval state machine for posts.

**Reproduction (safe).** Publish a post in a plan not approved.

**Impact.** Posts can go live without client approval (if approval is required by the business).

**Fix.** Decide the rule; if approval is required, reject publish unless plan.status='approved'; require auth_is_staff for the publisher.

**Acceptance criteria.** Rule enforced and tested.

**Required tests.** Edge tests.

**Verification method.** Test in staging.

**Why this classification.** Low/Potential: depends on spec.

---

### OPS-03 — Unbounded growth: Drive log/thumbnail cache, notifications, audit logs

| Field | Value |
|---|---|
| Category | Operations |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | OPS-03 |
| Affected module | Kite Drive / data lifecycle |
| Affected files | `integrations/kite-drive/api/index.php:L218-L229`<br>`integrations/kite-drive/api/send.php (thumbnail cache)`<br>`supabase/functions/_shared/auth.ts (notify/audit)` |
| Relevant functions | `log_action`, `drive_send_thumbnail` |
| Graph node IDs | `php:index`, `php:send`, `ext:drive-disk`, `job:drive-cleanup`, `tbl:notifications`, `tbl:audit_logs` |
| Related workflows | Kite Drive file access, Notifications and push |
| Related tables | `notifications`, `audit_logs`, `push_subscriptions` |
| Fix package | FX-12, FX-03 |
| Status | Open |

**Description.** Drive _log/actions.log is append-only; _thumbs/ grows with every new mtime; no code deletes rows from notifications, audit_logs or push_subscriptions (grep over functions, migrations, js).

**Root cause.** No retention policy.

**Reproduction (safe).** Inspect file sizes and table row counts over time.

**Impact.** Disk and table bloat; slower queries over time.

**Fix.** Rotate the Drive log (logrotate or size check); evict thumbnails older than 90 days in remove_stale_uploads; scheduled SQL retention: notifications read >90 days, audit_logs archived >2 years to cold storage.

**Acceptance criteria.** Retention jobs run and are recorded in job_runs; log size bounded.

**Required tests.** SQL test for the retention function.

**Verification method.** Row-count trend after one month.

**Why this classification.** Low: slow-burn operational risk.

---

### PERF-03 — Many browser reads are unbounded or select('*')

| Field | Value |
|---|---|
| Category | Performance |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Frontend data access |
| Affected files | `js/modules/**/*.js (13 select('*'), 18 limit/range vs 162 .from calls)` |
| Relevant functions | — |
| Graph node IDs | `fe:shell`, `ext:postgrest` |
| Related workflows | — |
| Related tables | `tasks`, `notifications`, `messages` |
| Fix package | FX-13 |
| Status | Open |

**Description.** Counts from source: 162 .from() call sites, 13 select('*'), 18 limit/range. Pagination was added in commit ad3afc2 but not every list is bounded. Per-query review not done.

**Root cause.** Pagination applied module by module.

**Reproduction (safe).** List queries with >1000 rows.

**Impact.** Slow pages and large payloads at scale.

**Fix.** Audit each query; add range/limit and explicit columns; central query helper with default limit.

**Acceptance criteria.** No query without limit except documented exceptions.

**Required tests.** Lint/grep check.

**Verification method.** Count unbounded queries.

**Why this classification.** Low/Potential: unmeasured.

---

### PERF-04 — Drive PHP does uploads, zip and thumbnails synchronously on shared hosting

| Field | Value |
|---|---|
| Category | Performance |
| Severity | LOW |
| Priority | P3 |
| Confidence | Unverified |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Kite Drive |
| Affected files | `integrations/kite-drive/api/index.php (zip_prepare, extract_zip, thumb)`<br>`integrations/kite-drive/api/send.php` |
| Relevant functions | `zip_prepare`, `extract_zip`, `drive_send_thumbnail` |
| Graph node IDs | `php:index`, `php:send`, `ext:hostinger` |
| Related workflows | Kite Drive file access |
| Related tables | — |
| Fix package | FX-13 |
| Status | Open |

**Description.** Zip building, zip extraction (up to 5000 entries), GD thumbnails (up to 50 MP) and 8 MB chunk handling run inside PHP requests. Limits (post_max_size, memory, time) were not observed.

**Root cause.** Synchronous processing.

**Reproduction (safe).** Upload large zip in staging.

**Impact.** Timeouts on large operations.

**Fix.** Measure with representative files; set explicit memory/time limits; thumbnail generation lazily with queue if needed.

**Acceptance criteria.** Documented limits and measured pass/fail for target sizes.

**Required tests.** Manual load script.

**Verification method.** Run on Hostinger staging.

**Why this classification.** Low/Unverified.

---

### SEC-03 — Client-triggered notification endpoints are replayable or unverified

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-03 |
| Affected module | Notifications |
| Affected files | `supabase/functions/workflow/index.ts:L564-L576,L582-L614` |
| Relevant functions | `leaveSubmitted`, `expenseSubmitted`, `taskFileAdded` |
| Graph node IDs | `fn:workflow`, `shared:auth`, `tbl:notifications` |
| Related workflows | Expense and leave approval, Notifications and push |
| Related tables | `notifications`, `leave_requests`, `expenses` |
| Fix package | FX-11 |
| Status | Open |

**Description.** leave.submitted and expense.submitted verify ownership but allow repeated calls within 10 minutes. task.file_added performs no check that an attachment exists: any user who can see a task can send 'X uploaded <free text>' to all participants, repeatedly.

**Root cause.** Notifications are driven by browser calls rather than by the database event.

**Reproduction (safe).** Call task.file_added twice with arbitrary fileName; both notify.

**Impact.** Nuisance and message spoofing inside a task audience.

**Fix.** Insert a notifications dedupe key (type+entity+recipient) with a unique index and ON CONFLICT DO NOTHING; verify an attachment row for file_added; or move to DB triggers/outbox (FX-11).

**Acceptance criteria.** Second identical call creates no notification; file_added without an attachment returns 404.

**Required tests.** Edge tests for replay and missing attachment.

**Verification method.** Count notifications after replay.

**Why this classification.** Low: internal audience, no data exposure.

---

### SEC-04 — Request body size guard reads whole body and counts characters

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-04 |
| Affected module | Edge shared |
| Affected files | `supabase/functions/_shared/http.ts:L44-L46` |
| Relevant functions | `readJson` |
| Graph node IDs | `shared:http` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-15 |
| Status | Open |

**Description.** readJson awaits req.text() before comparing text.length (characters) to maxBytes; finance allows 200 000.

**Root cause.** Check after full read.

**Reproduction (safe).** Send a multi-megabyte body; platform limits apply first.

**Impact.** Weak resource bound.

**Fix.** Check Content-Length first and read via a capped stream; compare bytes.

**Acceptance criteria.** 413 returned before the body is buffered.

**Required tests.** Unit test with oversized body and multi-byte text.

**Verification method.** Test in staging.

**Why this classification.** Low: platform limits mitigate.

---

### SEC-05 — innerHTML surface relies on manual escaping

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Low / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-05 |
| Affected module | Frontend |
| Affected files | `js/utils/helpers.js:L9-L17`<br>`js/utils/linkify.js:L11-L22`<br>`js/ui/dialogs.js:L66-L82`<br>`js/router.js:L106` |
| Relevant functions | `escapeHTML`, `linkify`, `fieldHTML`, `renderBreadcrumbs` |
| Graph node IDs | `fe:utils`, `fe:ui`, `fe:shell` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-09 |
| Status | Open |

**Description.** 163 innerHTML uses vs 429 escapeHTML calls. Read in full and found correct: escapeHTML (text and quoted attribute contexts), linkify (escapes first, http/https only, entity-encoded quotes cannot break the attribute), preview.js, dialogs fieldHTML (labels/values escaped). A heuristic scan flagged 27 unescaped-looking interpolations; the 8 inspected were static labels or select labels that formDialog escapes. router.renderBreadcrumbs inserts crumbs unescaped (static today). No confirmed XSS sink.

**Root cause.** Escaping is a convention, not enforced; strict CSP (script-src 'self') is the backstop.

**Reproduction (safe).** n/a (no confirmed sink).

**Impact.** A future unescaped interpolation of user data becomes stored XSS limited by CSP (no inline script).

**Fix.** Add ESLint rule (no-unsanitized/property + a custom rule flagging template literals in innerHTML without escapeHTML); introduce html`` tagged template that escapes by default; escape breadcrumbs.

**Acceptance criteria.** Lint passes with zero unescaped interpolations of non-literal data.

**Required tests.** Lint in CI; unit tests for escapeHTML/linkify with attribute-breaking payloads.

**Verification method.** Run the lint rule over js/.

**Why this classification.** Low: no confirmed defect; strong evidence of disciplined escaping where read; remaining sites unreviewed.

---

### SEC-08 — Employee directory exposes phone, joining date and employment type to all staff

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Identity / privacy |
| Affected files | `supabase/migrations/002_rls_policies.sql:L246-L249,L265-L268`<br>`js/config.js (PROFILE_COLUMNS)` |
| Relevant functions | `profiles_select`, `column GRANT SELECT` |
| Graph node IDs | `tbl:profiles`, `fe:employees` |
| Related workflows | — |
| Related tables | `profiles` |
| Fix package | FX-01 |
| Status | Open |

**Description.** profiles_select allows any staff to read every profile; the column grant includes email, phone, joining_date, employment_type, manager_id and location. Whether all staff should see these is a policy decision that the empty Notion spec cannot confirm.

**Root cause.** Single directory policy for all staff.

**Reproduction (safe).** As a normal employee query profiles.

**Impact.** Privacy exposure of HR attributes to junior staff.

**Fix.** Decide per field; move sensitive fields (phone, joining_date, employment_type) to an HR-visible view or restrict via column grants plus a SECURITY DEFINER directory view.

**Acceptance criteria.** Documented decision implemented and tested.

**Required tests.** RLS scenario per role.

**Verification method.** Query as employee.

**Why this classification.** Low: possibly intended; needs the spec.

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
