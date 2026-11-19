# Remediation Roadmap

Every issue appears in exactly one fix package (FX-xx). Dependencies are drawn in `REMEDIATION_DEPENDENCY_GRAPH.mmd`. Nothing here has been implemented. No fix requires downtime; all migrations are additive or written NOT VALID first, then validated.

## P0 — Immediate critical fixes
**None are confirmed.** One conditional item:

| Item | Trigger | Action |
|---|---|---|
| ARC-01 interim patch | `SELECT name FROM roles WHERE name='ceo'` returns a row on the live project, **or** any non-admin HR/finance account exists that should not be able to grant roles | Apply the interim part of FX-01 the same day: add `ceo`, `finance_manager`, `accountant` to the protected/admin-level lists in `invite-employee` (L14) and `workflow` (L413), including the "target is protected" checks (invite-employee L33-L34, workflow L429). Code-only, no migration. |

## P1 — High-priority fixes
### FX-02 — CI and a complete RLS/role test matrix (OPS-02, TST-01 part)
| | |
|---|---|
| Components | `supabase/tests/verify-rls.mjs`, new `.github/workflows/ci.yml`, new Deno tests in `supabase/functions/**`, PHP token vectors |
| Changes | Apply all migrations 001-019 in order in the harness (today 001-005, 016, 017 only). Add scenarios: 007 asset path, 009 content plans, 012 post guard/feedback, 015 owner-only money and client department scope, 019 drive links no grants. Add role matrix (super_admin, owner, ceo, general_manager, hr_manager, finance_manager, accountant, manager, employee, client, suspended). Add Deno tests for `getCaller` and each function's authorization. CI runs on every PR. |
| DB changes | None |
| Migration risk | The first full run may fail on an existing migration ordering problem (e.g. 017 assumes tables from earlier files): fix the harness, not production. |
| Backward compat | n/a |
| Depends on | nothing (start here) |
| Testing | The harness is the test; add a meta-test that every file in `supabase/migrations` is applied. |
| Deployment | GitHub only. |
| Rollback | Remove the workflow. |
| Acceptance | CI shows 19 migration OK lines; suite green; role matrix present; checklist counts match CI. |

### FX-03 — Scheduler as code, run ledger, alerts (OPS-01, OPS-04)
| | |
|---|---|
| Components | `due-reminders`, `retainer-billing`, new `job_runs` table, cron definitions, uptime/alert config, backup configuration |
| Changes | Migration with `cron.schedule(...)` via pg_cron + pg_net (secret read from Vault, not committed) or an exported dashboard config in the repo; both functions write `job_runs`; a daily watchdog alerts if a job is older than 26 h; document and test backup restore (Supabase and Hostinger), uptime check on `/login.html`, 5xx alerting, secret rotation runbook. |
| DB changes | `job_runs(job text, started_at, finished_at, ok bool, detail jsonb)`; staleness view. |
| Migration risk | Low. Do not create a second schedule while the dashboard entry exists (double run is idempotent but noisy): remove the dashboard entry in the same change window. |
| Backward compat | Functions keep the `x-cron-secret` header. |
| Depends on | nothing |
| Testing | Function tests writing `job_runs`; SQL test for the staleness view; restore drill. |
| Deployment | Apply migration, deploy functions, delete dashboard cron, verify next-day rows. |
| Rollback | `cron.unschedule`, restore dashboard entry. |
| Acceptance | One `job_runs` row per job per day; alert fires in a deliberate test; restore drill documented in the last 90 days. |

### FX-01 — Canonical role model and centralized authorization (ARC-01, SEC-08)
| | |
|---|---|
| Components | `_shared/auth.ts`, `invite-employee`, `workflow`, `kite-drive`, `broadcast`, `finance`, SQL `auth_is_*`, `js/permissions/permission-service.js`, `js/services/money.js`, `js/modules/broadcast/broadcast.js` |
| Changes | Interim (P0-conditional above). Durable: `roles.capabilities text[]` (or `role_capabilities`), SQL `auth_has_capability(text)`, `getCaller` loads capabilities, Edge uses `caller.can('...')`, browser reads capabilities once via RPC. Remove every role-name list; decide general_manager vs expense approval/read (workflow L276 vs 015). Decide directory fields visible to staff (SEC-08). |
| DB changes | New column/table, seed mapping for all existing roles, new SQL function; existing `auth_is_*` re-implemented on top of capabilities. |
| Migration risk | **High**: a wrong mapping changes access for real users. Mitigate by generating the mapping from the current lists and diffing effective access per role before and after (matrix test). |
| Backward compat | Keep `auth_is_*` function names; keep role names unchanged. |
| Depends on | FX-02 (matrix must exist first) |
| Testing | Matrix across all roles x actions in SQL, Edge and UI. |
| Deployment | Migration first (additive), then Edge Functions, then browser, then delete old lists. |
| Rollback | Re-point `auth_is_*` to the old definitions (kept in the migration as comments / a down script). |
| Acceptance | No role-name literal outside seed; matrix passes; hr_manager gets 403 on ceo/owner/finance changes. |
| Must not run independently | Do not change SQL helpers without the Edge and browser changes in the same release. |

### FX-04 — Public share endpoint hardening and shared rate limiter (SEC-01, SEC-07)
| | |
|---|---|
| Components | `client-preview`, `content-plan`, `chat`, `_shared`, `preview.js`, campaigns UI |
| Changes | `rate_limits(key, window_start, n)` with atomic upsert; helper `rateLimit()`; per-IP+token limits for preview; `approve_all` idempotent; default share expiry (30 days) and revoke/rotate controls in the UI; coalesced notifications for feedback; limits on `message.send`, `call.start`, comments, `push.test`. |
| DB changes | New `rate_limits` table (service role only), cleanup job (uses FX-03). |
| Migration risk | Low. Behavior change: existing never-expiring links keep working until staff regenerate (do not force-expire without notice). |
| Backward compat | Existing tokens stay valid; UI shows expiry. |
| Depends on | nothing |
| Testing | 50-way concurrency test; expiry/revoke tests; notification count assertions. |
| Deployment | Migration, functions, UI. |
| Rollback | Remove limiter calls (helper is additive). |
| Acceptance | See SEC-01 / SEC-07. |

## P2 — Important engineering improvements
### FX-05 — Kite Drive token transport and link compensation (SEC-02, DAT-01, PERF-04) — PHP + Edge + SPA together
| | |
|---|---|
| Components | `integrations/kite-drive/api/index.php`, `send.php`, `kite-drive` function, `drive-panel.js` |
| Changes | PHP: cookie session action + `delete_client`; Edge: idempotent `link.create`, `link.set` requires `replace`, compensating delete; SPA: use cookie/headers, remove `?token=`; Referrer-Policy; log filtering; measure PHP limits. |
| DB changes | None (Supabase); Drive MySQL unchanged. |
| Migration risk | Cross-system version skew: deploy order is PHP (accept both) -> Edge -> SPA -> PHP (remove query path). CORS/cookie `SameSite=None; Secure` must be tested across the Vercel and Hostinger origins. |
| Backward compat | Old SPA keeps working until step 4. |
| Testing | PHP cookie/expiry/cid tests; failure-injection test for link.create. |
| Deployment | As above with a staging Hostinger path first. |
| Rollback | Re-enable the query path in PHP. |
| Acceptance | No `token=` in logs; forced failure leaves no orphan. |
| Must not run independently | The three components in one coordinated release train. |

### FX-07 — Browser-insert validation constraints and currency model (DAT-04, DAT-06)
| | |
|---|---|
| Components | migrations (new 020), `hr.js`, `finance.js`, `chat` function, notification text |
| Changes | CHECK end_date >= start_date; trigger computing total_days (excluding weekends/holidays per policy); messages length/type/metadata constraints and split insert policy; expenses currency default from settings plus CHECK; receipt_path prefix check; UI uses row currency. All NOT VALID first. |
| DB changes | Constraints/triggers; backfill expenses.currency after deciding the real currency. |
| Migration risk | Existing rows may violate new constraints: report, clean, then VALIDATE. Do not backfill currency blindly. |
| Backward compat | Old UI still inserts valid data. |
| Depends on | FX-02 |
| Testing | SQL scenarios for each rejected insert; UI regression. |
| Deployment | Migration (NOT VALID), data cleanup, UI, VALIDATE. |
| Rollback | Drop constraints (additive). |
| Acceptance | See DAT-04, DAT-06. |
| Must not run independently | Schema, UI and data cleanup together. |

### FX-08 — Bind asset paths to uploader (SEC-06)
Components: `assets` policies/storage policy. Changes: CHECK `storage_path LIKE uploaded_by::text || '/%'` NOT VALID, tightened `assets_insert/update` WITH CHECK, trigger forbidding path change, then VALIDATE. Risk: legacy rows with other prefixes (list and fix first). Depends on FX-02. Rollback: drop CHECK/trigger. Acceptance: foreign-path insert/update denied; suite scenario.

### FX-06 — Atomic employee/role/department administration (DAT-05, DAT-08)
Components: `workflow employee.update`, `invite-employee`, new SQL functions, `chat dm.create`, `broadcast`. Changes: `admin_set_user_roles`, `admin_set_user_departments` transactional with last-super-admin rule across role change, deactivation and delete; `conversations.pair_key` unique; broadcast row inserted first; reaction toggle as one statement; paged `listUsers`. DB: functions, unique index (check for existing duplicate DMs first). Risk: duplicate DM cleanup. Depends on FX-01. Rollback: switch Edge back to old code path. Acceptance: DAT-05/DAT-08 criteria.

### FX-10 — Business time zone in finance SQL (FUN-02)
Components: `fin_*` functions, `finance_settings`. Changes: `finance_settings.timezone` default `Africa/Cairo`, helper `fin_today()`, replace `current_date` in payment/issue/refresh/overdue. DB: column + functions (CREATE OR REPLACE). Risk: invoices on the boundary may flip status once; run before month-end review. Depends on FX-02. Acceptance: boundary test at 23:30 UTC passes.

### FX-11 — Notification outbox, batching and dedupe (PERF-01, SEC-03)
Components: `_shared/auth.ts notify`, `push.ts`, `broadcast`, `workflow`, `chat`. Changes: bulk insert, one subscription query per batch, push via queue/worker, unique dedupe key `(type, entity_id, user_id, window)`. DB: `notification_outbox`, unique index. Risk: delivery latency and failure handling change; keep synchronous path behind a flag for rollout. Depends on FX-04. Rollback: flag off. Acceptance: 200-recipient broadcast under 5 s; replay creates no duplicates.

### FX-09 — Router render guard, module unmount contract, lint (FUN-01, SEC-05, ARC-02)
Components: `router.js`, `realtime-service.js`, all modules (incrementally), ESLint config. Changes: renderId guard, `unmount()` hook, Realtime owner token, ChatModule teardown, escape-by-default `html` helper and lint rule. Risk: module regressions: roll out module by module behind tests. No DB. Depends on nothing. Acceptance: rapid-navigation Playwright test; leaving chat removes channels.

### FX-13 — Performance baselines, indexes, pagination audit (PERF-02, PERF-03)
Components: slow queries, `tasks`/`messages` policies, browser queries. Changes: EXPLAIN baselines, missing indexes, policy rewrites, default limits. DB: indexes (CREATE INDEX CONCURRENTLY). Risk: policy rewrites change semantics: covered by FX-02 matrix. Depends on FX-11 (measure after outbox). Acceptance: agreed P95 at 10x rows.

## P3 — Long-term improvements
### FX-12 — Data lifecycle (OPS-03, DAT-03, DAT-07, DAT-09)
Retention job (notifications, audit archive), Drive log rotation and thumbnail eviction, storage orphan cleanup/outbox, client archive instead of delete, soft-delete tasks. Depends on FX-03 (scheduler + ledger). Risk: destructive: run in report-only mode first, review, then enable. Rollback: disable job (soft deletes are reversible).

### FX-14 — Documentation reconciliation (DOC-01, DOC-02, DOC-03)
Generate the table catalog from migrations, rewrite trigger/business-logic sections, rewrite the production checklist from CI facts, fill the Notion specification. Depends on FX-01 and FX-07. No runtime risk.

### FX-15 — Small hardening and rule decisions (SEC-04, DAT-02, FUN-03, FUN-04, FUN-05, ARC-03)
Capped body reads, drop legacy money/invoice columns after reader check, task.update field rules, digest ordering/chunking, publish/approval rule, remove unused invitation token. FUN-03/FUN-05 need the business rule from the Notion spec first. Depends on FX-02.

## Parallelism
- Start immediately and in parallel: FX-02, FX-03, FX-04, FX-09.
- After FX-02: FX-01, FX-07, FX-08, FX-10, FX-15 can run in parallel (separate migrations, no shared tables) except FX-01 and FX-06 which share role tables.
- FX-05 is independent but needs a Hostinger window.
- FX-11 after FX-04; FX-13 after FX-11; FX-12 after FX-03; FX-14 last.

## What could break during remediation
1. FX-01: wrongly mapped capabilities silently grant or deny access: guard with the before/after matrix.
2. FX-07: NOT VALID constraints applied but not validated leave old bad rows; validating can fail on existing data.
3. FX-05: version skew between Hostinger PHP and the Edge/SPA; cookies across two domains.
4. FX-03: duplicate schedules during cut-over.
5. FX-11: delayed or lost pushes while moving to an outbox.
6. FX-12: deletion jobs: run report-only first.

## Verification gate
No issue moves to **Verified** until its Verification method in `MASTER_ISSUE_REGISTER.md` has been run on staging and, where marked, on production (see `VERIFICATION_PLAN.md`).
