# Operations & Infrastructure Issues

4 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| OPS-01 | Scheduled jobs exist only in the Supabase dashboard; no heartbeat or alerting | MEDIUM | P1 | Confirmed | FX-03 | Open |
| OPS-02 | No CI; RLS suite validates a different schema than production and docs overstate it | MEDIUM | P1 | Confirmed | FX-02 | Open |
| OPS-04 | Backups, restore, monitoring and alerting are not evidenced | MEDIUM | P1 | Unverified | FX-03 | Open |
| OPS-03 | Unbounded growth: Drive log/thumbnail cache, notifications, audit logs | LOW | P3 | Confirmed | FX-12, FX-03 | Open |

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
