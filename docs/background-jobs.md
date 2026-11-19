# Background jobs, scheduling and data lifecycle (Phase 7)

Migration `037_background_jobs.sql`, the changed Edge Functions and how to run and check them.
Nothing in this repository creates or changes a schedule: every cron below is set up **by hand** in the Supabase Dashboard
(and, for Kite Drive, on Hostinger). The repository only documents them and gives you queries that show whether they ran.

## 1. The scheduled jobs

| Job | What it does | Schedule (example) | Needs |
|---|---|---|---|
| `due-reminders` | 1. removes files whose rows were deleted (queue from migration 029), 2. marks expired invitations, 3. sends the daily deadline digest and the "posts to publish" reminders | daily 07:00 Cairo | `CRON_SECRET`, `REMINDER_TZ`; migrations 029, 032, 034, **037** |
| `retainer-billing` | creates the month's DRAFT retainer invoices, marks overdue invoices, tells the executives when drafts are waiting | daily 06:00 Cairo | `CRON_SECRET`; migrations 028, 033, **037** |
| Kite Drive stale-upload cleanup (Hostinger) | removes unfinished uploads, old ZIPs and old thumbnails | see section 5 | Hostinger access |

Both Edge Functions are called with the same two headers:

```
POST https://<project-ref>.supabase.co/functions/v1/due-reminders        (and .../retainer-billing)
Authorization: Bearer <anon key>
x-cron-secret: <CRON_SECRET>
```

Create each in Supabase Dashboard -> Integrations -> Cron -> HTTP request. **`retainer-billing` is easy to forget** (it was missing from
the checklist before Phase 7): without it no retainer draft is created and **no invoice ever becomes overdue**
(`fin_mark_overdue()` is called only by that function). Rotating `CRON_SECRET` means editing both cron jobs.

Deploy order: apply migration 037 first, then deploy the Edge Functions (`due-reminders`, `retainer-billing`, `broadcast`, `workflow`).
`due-reminders` calls `due_digest_batch()` / `publish_digest_batch()`, `broadcast` calls `broadcast_claim()` / `broadcast_finish()`:
they do not exist before 037. The job ledger itself is optional at run time (a missing ledger is logged and the job still runs).

## 2. How a run behaves (what changed)

* **No row caps.** The digest candidates come from SQL functions, read in pages of 200 people (keyset on user id). The two reads that
  PostgREST used to cut off silently at 1,000 rows are gone.
* **Housekeeping first.** Storage clean-up and invitation expiry run before the digest, so a slow or killed digest cannot skip them.
* **Resumable.** A person who already has today's digest (a notification in the last 20 hours, or today's dedupe key) is never a
  candidate again. If a run stops (time budget, crash, timeout), running it again continues with the people still missing. Nobody gets
  two digests, also when two runs overlap (database unique key `(user_id, dedupe_key)`).
* **Time budget.** After `JOB_TIME_BUDGET_MS` (secret, default 90000 ms) the function stops starting new batches and ends the run as
  `partial`. This is an engineering safety limit, not a business rule. Set it below your Edge Function limit.
* **Order.** People are processed in user-id order (before: the order the task query happened to return). Within one person's digest
  the wording and the item order (overdue, today, tomorrow) are unchanged; "Next:" is the most urgent item (oldest overdue first).
* **Ledger.** Every run writes a row to `job_runs` (`running` -> `succeeded` / `partial` / `failed`, details, checkpoint). A run that
  crashes stays `running`. **Nothing sends an alert**; there are no built-in thresholds or recipients.
* **Retainer alert.** "Retainer invoices ready to review" has one dedupe key per month (`invoice_drafts:YYYY-MM`), so a repeated run
  does not repeat it. If drafts of the month are still waiting and the alert was never stored, the next run sends it.
  Billing itself (`fin_retainer_generate`, `fin_mark_overdue`) is unchanged.

## 3. Verify that the jobs really run (read-only, service role / SQL editor)

```sql
-- one row per job: last start, how it ended, last SUCCESS, runs still marked running
SELECT * FROM public.job_status();

-- jobs that have not SUCCEEDED within an age YOU choose; name the jobs that must exist (a job that never ran is listed too)
SELECT * FROM public.job_missed_runs(interval '36 hours', ARRAY['due-reminders', 'retainer-billing']);

-- runs still "running" after an age you choose (a crashed or killed run)
SELECT * FROM public.job_stuck_runs(interval '1 hour');

-- the last runs with details (partial = the time budget ended the run; run it again)
SELECT id, job, status, started_at, finished_at, error, details, checkpoint FROM public.job_runs ORDER BY started_at DESC LIMIT 20;

-- everything else that needs a person
SELECT * FROM public.integrity_report() WHERE n > 0;
```

Cross-checks that do not need the ledger (also useful before 037 is applied):

```sql
SELECT max(created_at) FROM public.notifications WHERE type = 'due_digest';
SELECT max(created_at) FROM public.invoices WHERE kind = 'retainer';
SELECT jobid, schedule, active, left(command, 80) FROM cron.job;          -- only if pg_cron is used; else read Dashboard -> Integrations -> Cron
SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```

Manual re-run after a `partial` or `failed` run: call the function again with the same headers. It is safe to repeat.

## 4. Other Phase 7 changes

| Area | Change |
|---|---|
| Broadcasts | `broadcast_claim()` records the announcement atomically; a repeated request id with the same sender and content **resumes** an unfinished send (`broadcast:<id>` dedupe key per recipient: people already notified are skipped, also with several workers at once). Another sender or different content with the same request id answers 409. If the claim cannot be recorded, nothing is sent (before, it sent anyway). The recipient count is counted from the real notifications. **No stale-claim takeover** (needs an approved timeout). |
| Workflow notifications | Keyed by their event where one exists: expense decision, leave decision, task deleted, task comment, leave request, expense claim. Events without a stable identity (status change, reassign, edit, file added, role change) are deliberately not keyed, so a legitimate repeat is never swallowed. Notification preferences and push (including TTL) are unchanged. |
| `storage.cleanup` | The workflow action is limited to active `super_admin`, `owner`, `general_manager` (403 otherwise). The daily job and the delete actions still drain the queue on their own. |
| Storage queue (029) | `storage_cleanup_requeue(ids)` gives exhausted rows (12 attempts) fresh attempts and writes the old attempt count and error to `storage_cleanup_requeues`. `storage_cleanup_prune_candidates(age)` lists completed rows older than an age you pass. **Nothing is deleted.** Look at `last_error` first: a file that fails 12 times usually has a cause (bucket, permission, path). |
| Orphan uploads | `storage_orphans(age)` lists objects in `task-attachments`, `studio-assets`, `chat-media` that no row points at and that are not queued for removal. Read-only. The age protects uploads that are still being attached (the browser uploads first, then inserts the row); **choose a generous age** and review before anyone deletes anything. Other buckets are ignored. |
| Retainer drafts | `fin_retainer_drafts_unreviewed()` lists retainer invoices still in `draft` (no age or threshold). |
| `integrity_report()` | Now 19 rows: two new (jobs whose last run failed, retainer invoices in draft). |

```sql
-- exhausted storage files: look, then (when you decided) put them back
SELECT id, bucket, path, attempts, last_error FROM public.storage_cleanup_queue WHERE done_at IS NULL AND attempts >= 12;
SELECT public.storage_cleanup_requeue();                      -- all exhausted rows; or pass an array of ids
-- completed queue rows that could eventually be pruned (nothing is deleted by this)
SELECT * FROM public.storage_cleanup_prune_candidates(interval '90 days');
-- objects nobody points at (read only)
SELECT * FROM public.storage_orphans(interval '7 days');
SELECT * FROM public.fin_retainer_drafts_unreviewed();
```

(The intervals above are examples for the query, not policy.)

## 5. Kite Drive (Hostinger)

`integrations/kite-drive/api/index.php` removes unfinished uploads (`STALE_UPLOAD_SECONDS`, 2 days), ZIPs older than a day and thumbnails
older than 30 days in `remove_stale_uploads()`. **That function runs only when someone starts an upload.** There is no cron entry point
in the PHP code, so on a quiet system stale files stay until the next upload, and nothing records when it last ran. This phase did not
change the PHP or any Hostinger setting. To check on the server (read only):

* `api/_chunks/` (the upload area): files older than 2 days mean the cleanup has not run recently.
* `api/_zips/` older than 1 day, `api/_thumbs/` older than 30 days: the same.
* `api/_log/actions.log` is never rotated (it only grows). Check its size; rotating it is a decision for later.

**Decision needed before anything is scheduled on Hostinger:** whether to add a small cleanup entry point (protected by the existing
secret) that a Hostinger cron can call, or to accept request-driven cleanup. Until then there is no Hostinger cron to set up or verify.

## 6. Rollback

```
psql -f supabase/maintenance/rollback-037.sql
```

Restores the 17-row `integrity_report()` of 035 and drops everything 037 added (the ledger and the requeue history tables are dropped
with their rows). No other data is touched. Roll the Edge Functions back to the previous version at the same time: the old
`due-reminders` and `broadcast` do not call the new functions, so they work against the old database too. After a re-run of 017 the order
is 022 -> 028 -> 033 -> 035 -> 036 -> 037 (022 restores executive-only Finance).

## 7. Not done (needs a decision)

Alert thresholds and recipients, retention periods (notifications, activity logs, finance audit, completed queue rows, Drive log), soft
delete of tasks, stale-claim takeover for broadcasts (timeout), minimum age before an orphan may be deleted, push retry / queue (kept
off), honouring `notification_preferences`, a Hostinger cleanup entry point.

## 8. Tests

```
cd supabase/tests
npm run test:background      # real PostgreSQL: 5,000-user digest, concurrent workers, crash and resume, broadcasts, cleanup requeue,
                             # orphan detector, dedupe, admin-only cleanup, retainer alerts, ledger, rollback
```
The Edge Function files cannot be run here (no Deno): they are checked for syntax and for the rules above; the rules themselves live in SQL.
