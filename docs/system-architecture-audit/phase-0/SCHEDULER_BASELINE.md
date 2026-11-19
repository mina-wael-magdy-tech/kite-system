# Scheduler and Background Job Baseline

**Live state: NOT ACCESSIBLE.** No pg_cron, dashboard, Hostinger cron or log access. No repository file defines a schedule (`grep` for `cron.schedule`, `pg_cron`, `pg_net` over SQL/TS/TOML/MD outside the audit folder: no hits).

| Job | Defined where | Schedule source | Version-controlled? | Failure alert | Evidence |
|---|---|---|---|---|---|
| `due-reminders` (daily digest, notifications) | `supabase/functions/due-reminders/index.ts`; needs `x-cron-secret` = `CRON_SECRET` (≥24 chars) | header comment: set by hand in Dashboard → Integrations → Cron, daily ~07:00 Cairo; `REMINDER_TZ` secret | **No (dashboard-only)** | none documented (checklist L56 only suggests an alert on function error rate, unchecked) | REPO; live NOT ACCESSIBLE |
| `retainer-billing` (monthly retainer invoices, ledger) | `supabase/functions/retainer-billing/index.ts`; same secret | header comment: dashboard HTTP cron daily ~06:00 Cairo | **No** | none | REPO; live NOT ACCESSIBLE |
| Kite Drive stale-upload cleanup | `integrations/kite-drive/api/index.php` L14 `STALE_UPLOAD_SECONDS = 172800` (2 days) | trigger mechanism (cron vs on-request) **not verified** | file is versioned; any Hostinger cron is not | none | REPO; Hostinger NOT ACCESSIBLE |
| Push retry / outbox | none exists (push is fire-and-forget in `_shared/push.ts`) | n/a | n/a | n/a | REPO (see FX-11) |
| Cleanup of notifications / audit logs / orphan chat media | none exists | n/a | n/a | n/a | REPO (OPS-03, DAT-09) |

Observations
- `production-checklist.md` L44 mentions the `due-reminders` cron only; **`retainer-billing` is missing from the checklist**, so it can be forgotten at setup.
- Both jobs use a shared secret in a dashboard-held header; rotating `CRON_SECRET` requires updating both dashboard jobs by hand.
- No evidence of duplicate-run protection beyond what the functions themselves implement (not re-audited in Phase 0).

## Read-only checks to run (B1-B3 in `remediation/VERIFICATION_PLAN.md`)
```sql
SELECT jobid, schedule, active, left(command, 80) FROM cron.job;        -- if pg_cron is used; else read Dashboard → Integrations → Cron
SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
SELECT max(created_at) FROM notifications WHERE type = 'due_digest';
SELECT max(created_at) FROM invoices WHERE kind = 'retainer';
```
Record: active schedules, last success, failures, duplicates, jobs lacking alerts. Do not create, edit or toggle any job.
