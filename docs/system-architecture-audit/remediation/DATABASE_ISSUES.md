# Database & Data Integrity Issues

9 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| DAT-01 | Cross-system Drive account creation without compensation | MEDIUM | P2 | Confirmed | FX-05 | Open |
| DAT-04 | Browser-direct INSERT policies lack data validation (leave dates/days, message metadata/length, expense fields) | MEDIUM | P2 | Confirmed | FX-02, FX-07 | Open |
| DAT-05 | employee.update rewrites roles and departments non-atomically; last-super-admin safeguards incomplete | MEDIUM | P2 | Confirmed | FX-01, FX-06 | Open |
| DAT-06 | Currency model is inconsistent: expenses default to USD, company and invoices use EGP, UI shows EGP | MEDIUM | P2 | Confirmed | FX-07 | Open |
| DAT-03 | Client deletion vs invoices and Drive: unverified cascade behaviour | LOW | P2 | Unverified | FX-12 | Open |
| DAT-02 | Legacy money columns silently zeroed by trigger | LOW | P3 | Confirmed | FX-15 | Open |
| DAT-07 | task.delete removes files and notifies before deleting, and hard-deletes history | LOW | P3 | Confirmed | FX-12 | Open |
| DAT-08 | Check-then-insert races without database constraints (DMs, rate limits, re-invite scan) | LOW | P3 | Confirmed | FX-06 | Open |
| DAT-09 | Storage objects are orphaned when rows are deleted by cascade (channels, employees, plans) | LOW | P3 | Confirmed | FX-12, FX-03 | Open |

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
