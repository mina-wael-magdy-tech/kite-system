# Phase 8: Deployment runbook (Phases 0-7 + employee-ID hotfix)

Companion to `docs/PHASE_8_RELEASE_READINESS_AUDIT.md` (read it first: findings P0-xx / P1-xx are referenced here).
**This runbook has never been executed.** It was written from the repository only. Every step is LOCAL-level knowledge until a
rehearsal on staging (phase 2) confirms it. Nothing here was run against staging or production.

Rules that apply to every phase:
1. **Never `supabase db push` on the live project** (its migration history is empty). Apply migrations one file at a time, each as a single script (SQL editor, or `psql -v ON_ERROR_STOP=1 -f <file>`).
2. Do not merge this branch to `main` before phase 3 step D6 (`main` is the deployed branch; the web app must go last).
3. Stop at the first unexpected result. Do not "fix forward" on production during the release window; use the rollback decision tree (section 8).
4. Record every step's result (time, who, output) in the release log.

## Phase 0 / R0: read-only inventory (production AND staging; changes nothing)

Run in the SQL editor (read-only). Save the output with the release log.
All inventory queries are read-only (`SELECT` only). The queries in R0.1, R0.3, R0.3b, R0.4 and 7.1 were executed against a locally built
database to confirm they run (R0.3b with a mix of canonical and non-canonical IDs; R0.4 both with and without a `cron` schema); their
results on the live database are unknown.

```sql
-- R0.1 which migration objects exist (no history table exists, so probe the objects)
SELECT * FROM (VALUES
  ('020', to_regprocedure('public.replace_user_role(uuid,uuid,uuid)') IS NOT NULL),
  ('022', to_regprocedure('public.auth_is_finance()') IS NOT NULL AND pg_get_functiondef(to_regprocedure('public.auth_is_finance()')) !~ 'finance_manager'),
  ('023', to_regprocedure('public.guard_last_super_admin()') IS NOT NULL),
  ('024', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' AND column_name='finance_confidential')),
  ('025', to_regclass('finance_backup.notifications_pre025') IS NOT NULL),
  ('027', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assets_integrity_guard')),
  ('028', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_payments' AND column_name='request_id')),
  ('029', to_regclass('public.storage_cleanup_queue') IS NOT NULL),
  ('030', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='hr_attendance_guard')),
  ('031', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='expenses_status_guard')),
  ('032', to_regprocedure('public.chat_reaction_toggle(uuid,uuid,text)') IS NOT NULL),
  ('033', to_regprocedure('public.integrity_report()') IS NOT NULL),
  ('034', to_regprocedure('public.accept_invitation(uuid)') IS NOT NULL),
  ('035', to_regclass('public.lead_stage_history') IS NOT NULL),
  ('036', to_regprocedure('public.task_stats()') IS NOT NULL),
  ('037', to_regclass('public.job_runs') IS NOT NULL),
  ('038', to_regprocedure('public.format_employee_id(bigint)') IS NOT NULL)
) v(migration, applied) ORDER BY 1;
-- 021 and 026 have no single object to probe; infer them from their neighbours (022, 027) and re-apply: both are safe to re-run (headers).
-- Expected pattern: applied = true for a contiguous prefix. A gap (for example 022 false but 028 true) means STOP and investigate.

-- R0.2 policies: export for the diff against a database built from migrations 001-035 (P1-04)
SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;

-- R0.3 data pre-conditions
SELECT user_id, count(*) FROM public.user_departments WHERE is_primary GROUP BY 1 HAVING count(*) > 1;           -- 032: must return no rows
SELECT lower(email), count(*) FROM public.invitations WHERE status = 'pending' GROUP BY 1 HAVING count(*) > 1;   -- 032: must return no rows
SELECT conrelid::regclass, conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace;   -- note, do not "fix"
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;                            -- sizes: index-build locks (P1-05)
SELECT count(*) FROM public.profiles;                                                                             -- how far from 1,000 employees

-- R0.3b employee IDs (migration 038). Canonical = EMP- + 001..999 (three digits) or 1000 and up (no leading zero).
SELECT id, employee_id FROM public.profiles
 WHERE employee_id IS NOT NULL
   AND employee_id !~ '^EMP-(0(0[1-9]|[1-9][0-9])|[1-9][0-9]{2}|[1-9][0-9]{3,})$'
 ORDER BY employee_id;                                    -- non-canonical: hand-typed, lower-case, EMP-000, two-digit, AND zero-padded IDs above 999 (EMP-01000)
SELECT id, employee_id FROM public.profiles
 WHERE employee_id ~ '^EMP-[0-9]{1,15}$' AND substring(employee_id FROM 5)::bigint > 999
 ORDER BY employee_id;                                    -- every ID whose number is above 999, canonical or not (any row blocks rollback-038 and moves the sequence on apply)
SELECT count(*) AS profiles_without_employee_id FROM public.profiles WHERE employee_id IS NULL;
SELECT last_value, is_called FROM public.employee_id_seq;                                                         -- sequence state

-- R0.4 background jobs. pg_cron may not be installed: the first query says so; the next two run only when it is (they return no row, and no error, otherwise).
SELECT to_regclass('cron.job') IS NOT NULL AS pg_cron_installed;
SELECT query_to_xml('SELECT jobid, schedule, active, left(command, 80) AS command FROM cron.job ORDER BY jobid', true, false, '') AS cron_jobs
 WHERE to_regclass('cron.job') IS NOT NULL;
SELECT query_to_xml('SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20', true, false, '') AS cron_runs
 WHERE to_regclass('cron.job_run_details') IS NOT NULL;
-- If pg_cron is not installed, the Dashboard -> Integrations -> Cron list is the only source: read it by eye and record it.
SELECT max(created_at) FROM public.notifications WHERE type = 'due_digest';
SELECT max(created_at) FROM public.invoices WHERE kind = 'retainer';
```

Also record (CLI, read-only): `supabase functions list --project-ref <ref>` (which functions exist, versions, last update), `supabase secrets list`
(names only), and in Vercel: which branch is the production branch, the environment variables, and whether auto-deploy is on.
Check that **`setup-admin` is not deployed** and `SETUP_TOKEN` is unset (P1-09). On Hostinger: the date and content of `api/index.php`,
`api/lib.php`, `api/send.php`, and whether `api/config.php` has `url_tokens`.

Non-canonical or above-999 employee IDs found by R0.3b are **reported, never rewritten** (038 changes no ID). They matter for two reasons: any ID
with a number above 999 makes `rollback-038.sql` refuse, and 038 moves the sequence past the highest number found.

**Decision after R0:** the first missing migration is the start point. The branch's first release train is 020 -> 038. If R0 shows
022 is missing, 015 and 017 must be confirmed first (022 header: apply after 015, 017, 021).

## Phase 1: pre-deployment checklist (all must be ticked)

| | Item | Source |
|---|---|---|
| [ ] | R0 completed on production and staging; start point decided; policy diff reviewed (no unexplained live-only policy) | P0-01, P1-04 |
| [ ] | Documentation corrected: `docs/deployment.md` no longer says `db push`; recovery sequence after a 017 re-run reads **022 > 028 > 033 > 035 > 036 > 037** in `docs/database-integrity.md`, the 035 header, 036 notes | P0-05, P1-01 |
| [ ] | Owner approved migration 025 (it rewrites existing notification text) or it is skipped | 025 header |
| [ ] | Backup / PITR point taken and a **restore tested** on a separate project; recovery time recorded | P0-04 |
| [ ] | Maintenance window announced; low-traffic hour; named person on call; release log open | |
| [ ] | Staging isolation and sanitization checks of phase 2 (section 2.2) all passed before **any** staging job or notification was triggered: no real e-mail/push path, isolated secrets and VAPID keys, isolated Kite Drive test copy | P0-02 |
| [ ] | Staging rehearsal (phase 2) completed with every smoke test passing | P0-02 |
| [ ] | Platform Edge Function time limit confirmed; `JOB_TIME_BUDGET_MS` set below it | P0-03 |
| [ ] | Secrets present (section 6): `CRON_SECRET` (>= 24 chars), `REMINDER_TZ`, `ALLOWED_ORIGINS`, `APP_URL`, `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL`, VAPID_* | audit section 6 |
| [ ] | Owner decided cron schedule and who is told when a job fails (no alert is automatic) | P1-03 |
| [ ] | **Written owner approval to activate the production cron jobs (D5) is on record**; until then they are not created | D5 |
| [ ] | Previous versions saved: previous Vercel deployment id; previous Edge Function source (git tag/commit of what is live); previous PHP files copied from Hostinger; previous `config.php` | rollback |
| [ ] | Row counts of the big tables known; for large `tasks` / `notifications` / `messages` the `CREATE INDEX CONCURRENTLY` plan is ready (036 indexes) | P1-05 |
| [ ] | Branch not merged to `main` | P0-06 |

## Phase 2: staging rehearsal (an isolated Supabase staging project built from a sanitized copy of production)

The rehearsal must be unable to reach real people, real money, real client files or the production system. The requirements in 2.1 are
**conditions of starting**, not suggestions; the isolation checks in 2.2 run before any function, cron endpoint or notification is triggered.

### 2.1 Isolation requirements
| Area | Requirement |
|---|---|
| Project | A separate Supabase project with its own URL, keys, database password and service-role key. Production keys, the production database URL and the production service-role key are **never** copied to the staging machine, Vercel project or any CI. |
| Data | Build staging from a production backup **only if it is sanitized before anything is connected to it**: replace every e-mail with a sandbox address (for example `user<n>@staging.test`), remove phone numbers, pseudonymize names where feasible, delete all rows of `push_subscriptions`, clear invitation tokens and open invitations, and clear or replace notifications, announcement text and finance data that is not needed. Where a sanitized copy is not feasible, use synthetic test data. The sanitization script is reviewed before use (it is not part of this repository). |
| Test accounts | Dedicated test accounts, one per role under test (owner, general manager, department manager, employee, finance manager, client), with addresses in the sandbox domain. Test with those accounts only. |
| E-mail | Staging Auth SMTP is **disabled or pointed at a sandbox inbox** (a catch-all test mailbox such as Mailpit, Mailtrap or Inbucket). Production SMTP credentials are not configured. Invitation, reset and confirmation e-mails must be impossible to deliver to a real address. |
| Push | **New VAPID keys generated for staging** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` with a test subject). The production keys are not used. `push_subscriptions` is empty except for the tester's own device, subscribed against the staging site. |
| Secrets | New, staging-only values for `CRON_SECRET`, `ALLOWED_ORIGINS` (the staging site origin only), `APP_URL` (staging), `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL`, `JOB_TIME_BUDGET_MS`. `SETUP_TOKEN` unset. No secret is shared with production. |
| Kite Drive | A **separate test copy** of Kite Drive on Hostinger (its own folder or subdomain, its own MySQL database and upload folder), with its own `config.php` and secret and **no real client files** (sanitized or synthetic samples only). The staging `kite-drive` function points only at it. |
| Web app | A separate Vercel project or preview with the staging `SUPABASE_URL` and anon key. Its URL is added to the staging `ALLOWED_ORIGINS`, `APP_URL` and Auth redirect URLs only. |
| Cron | Staging cron jobs are **not scheduled** during the rehearsal. Endpoints are called manually, one at a time, after 2.2 passes. |
| Prohibited | Sending any notification, push, e-mail or announcement to a real production user from staging; staging calling a production endpoint, database or Drive; using a production secret or key; running a staging cron against production; testing announcements with an audience larger than the test accounts. |

### 2.2 Isolation checks (read-only; all must pass before any Edge Function, cron endpoint or notification is triggered)
```sql
SELECT count(*) FROM public.push_subscriptions;                                     -- expect 0 (or only the tester's own staging device)
SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@staging.test';              -- expect 0 (use your own sandbox domain)
SELECT count(*) FROM public.profiles WHERE email NOT LIKE '%@staging.test';         -- expect 0
SELECT count(*) FROM public.invitations WHERE status = 'pending';                   -- expect 0
```
Also confirm by eye: Auth -> SMTP settings (sandbox or disabled); the staging secrets list differs from production (`supabase secrets list` shows names and digests);
the VAPID public key differs from production; `KITE_DRIVE_URL` is the test copy; the Vercel project is the staging one; the cron list is empty.
If any check fails, **stop and sanitize again**. Do not "just try" a job.

### 2.3 What to run on staging
* Repeat phase 3 (D1-D8) exactly, including the Kite Drive order in D3/D4.
* Run the three rollback scripts once (038 only if no ID above 999 exists, otherwise confirm it refuses), then re-apply.
* Run the 017 re-run recovery once and verify with the post-deployment queries. The sequence is **022 > 028 > 033 > 035 > 036 > 037**.
* Call each cron endpoint manually, then check `job_status()`. Digests and announcements reach test accounts only.
* Real-browser pass of every smoke test in section 7, on desktop and phone width.
* Write down every deviation. Anything that differs from this runbook changes the runbook before production.

## Phase 3: production deployment

Order matters: **database -> Edge Functions -> Hostinger PHP -> cron -> web app last.** Every step has a verification and a stop rule.

### D0 Freeze and backup
1. Announce the window. Stop deployments to this project.
2. Take the backup / PITR marker; note its timestamp. Confirm the restore test from phase 1 is recorded.

### D1 Database (one file at a time, in order, from the start point decided by R0)
For each file `NNN` apply it as one script and run its check before the next.

| Order | File | Verify after |
|---|---|---|
| 1 | `020_atomic_role_replace.sql` | `to_regprocedure('public.replace_user_role(uuid,uuid,uuid)')` not null |
| 2 | `021_auth_is_owner_privileges.sql` | no error |
| 3 | `022_finance_executive_only.sql` | R0.1 row 022 true |
| 4 | `023_last_super_admin_guard.sql` | R0.1 row 023 true |
| 5 | `024_finance_confidential_assets.sql` | R0.1 row 024 true |
| 6 | `025_redact_financial_notifications.sql` | **only with owner approval**; `finance_backup.notifications_pre025` has rows |
| 7 | `026_client_asset_scope_and_path_binding.sql` | no error |
| 8 | `027_plan_asset_integrity_and_asset_ownership_guard.sql` | R0.1 row 027 true |
| 9 | `028_finance_integrity.sql` | R0.1 row 028 true |
| 10 | `029_history_protection.sql` | R0.1 row 029 true; `SELECT * FROM storage_cleanup_status()` |
| 11 | `030_hr_integrity.sql` | R0.1 row 030 true |
| 12 | `031_approvals_and_expenses.sql` | R0.1 row 031 true |
| 13 | `032_atomic_operations.sql` | R0.1 row 032 true |
| 14 | `033_database_hygiene.sql` | `SELECT count(*) FROM integrity_report()` = 13 |
| 15 | `034_invitation_activation.sql` | R0.1 row 034 true |
| 16 | `035_phase5_business_correctness.sql` | integrity_report = 17 rows |
| 17 | `036_performance.sql` (create the six `created_at` indexes by hand with `CONCURRENTLY` first if the tables are large) | `to_regprocedure('public.task_stats()')` not null; policy diff vs R0.2 only in the expected rewritten text |
| 18 | `037_background_jobs.sql` | integrity_report = **19 rows**; `SELECT * FROM job_status()` returns no error |
| 19 | `038_employee_id_format.sql` | `SELECT public.format_employee_id(1000)` = `EMP-1000`; the column default no longer contains `lpad` |

If any file errors, **stop**. Do not retry blindly: read the error, check R0.3, and use the decision tree. If a start point later than 020 was chosen, skip the files already applied.
Anything that re-runs migration 017 must be followed by **022 > 028 > 033 > 035 > 036 > 037** (not "028 > 033 > 035 > 036").

### D2 Database acceptance (read-only)
Run the post-deployment SQL smoke tests (section 7.1). All must pass before D3.

### D3 Edge Functions (CLI `supabase functions deploy <name> --project-ref <ref>`)
Order: **database -> Edge Functions (except `kite-drive`) -> Hostinger PHP (D4) -> `kite-drive` function (D3b) -> cron (D5, approval-gated) -> web app (D6).**
1. Set or confirm secrets first (`supabase secrets set ...`; section 6).
2. `accept-invitation`, `invite-employee` (need 034).
3. `workflow`, `chat`, `client-preview`, `content-plan`, `finance`.
4. `broadcast`, `retainer-billing`, `due-reminders` (need 037). Do **not** call the cron endpoints yet.
5. Confirm `setup-admin` is not deployed.
6. **Do not deploy `kite-drive` yet: do D4, then D3b.**
After each deploy: `supabase functions list` shows the new version; call a harmless authenticated action (section 7.2) and read the function logs.

### D4 Hostinger PHP (Kite Drive)
Why the PHP goes before the `kite-drive` function: the new PHP is backward compatible (it accepts tokens with or without a `jti` and, while
`url_tokens` is `legacy`, both token transports, so the old web app and the old function keep working), whereas the new function with the
old PHP works but **without the new protections** (see the table below). PHP first therefore never leaves a weaker window.
1. Back up the current `api/` folder and the live `api/config.php`.
2. Upload the three runtime files **together**: `index.php`, `lib.php` (new in Phase 4; `index.php` requires it) and `send.php`.
3. **Do not upload or copy `config.sample.php` over `config.php`.** `config.php` is the live file: it holds the shared secret and the database
   credentials, it is **not in the repository**, and replacing it would lock Drive out (secret mismatch) or break its database connection.
   `config.sample.php` is only the template for a new installation (`docs/kite-drive.md`, section on set-up) and is never read by the application. It changed in Phase 4 by one
   addition, the option `'url_tokens' => 'legacy'`. Compare the sample with the live `config.php` and add that one line to the **live** file by hand
   (if the key is missing the code already defaults to `legacy`, so adding it only makes the later switch explicit). Do not change any other value.
4. Check `https://<drive host>/api/config.php` answers **403** (it must never be readable), `api/_chunks`, `api/_zips`, `api/_thumbs`, `api/_log` are writable, and the API answers.
5. Tests (`tests/lib_test.php`) are not uploaded.

### D3b `kite-drive` Edge Function (after D4)
Prerequisites: migration 032 applied (`drive_link_*` functions), D4 done, secrets `KITE_DRIVE_API_SECRET` (equal to the secret in the live `config.php`)
and `KITE_DRIVE_URL` set. Deploy: `supabase functions deploy kite-drive --project-ref <ref>`.

| Question | Answer |
|---|---|
| When can it be **deployed**? | Any time after migration 032: publishing the function calls nothing. The recommended time is after D4. |
| When can it be **invoked** safely? | Only after D4 **and** with the secrets matching. Invoked earlier (against the old PHP) it works, because the old PHP ignores the extra claims (documented in `docs/phase4-release.md`, not re-tested here), but the protections stay off: address-carried download/ZIP tokens are not single-use, view tokens are not locked to one file, and the per-e-mail lock on creating a Drive account is missing. Confirm this on staging. |
| What does the web app need? | Both D4 and D3b (file-locked view tokens come from the new function; header-token thumbnails need the new PHP). The web app therefore goes last (D6). |
| What if D3b happens before D4 anyway? | It is a degraded but working state, not an outage. Do D4 as soon as possible; do not switch `url_tokens` to `strict`. |
| Verify | An authenticated call lists clients; thumbnails and a download work in a browser test account; the function log shows no `create_client outcome unknown`. |

### D5 Cron jobs: separate, approval-gated, production only after D1-D4 and D3b have passed acceptance
**Gate:** the owner's written approval to activate the production cron jobs must be on record (phase 1 checklist). Until then the jobs are not created. Staging cron is never scheduled during the rehearsal.
Jobs are created by hand (Dashboard -> Integrations -> Cron -> HTTP request):

| Job | URL | Headers | Suggested schedule |
|---|---|---|---|
| `retainer-billing` | `https://<ref>.supabase.co/functions/v1/retainer-billing` | `Authorization: Bearer <anon key>`, `x-cron-secret: <CRON_SECRET>` | 06:00 Africa/Cairo daily |
| `due-reminders` | `https://<ref>.supabase.co/functions/v1/due-reminders` | same | 07:00 Africa/Cairo daily |

Method POST. Convert the Cairo hour to the cron's time zone (UTC unless the Dashboard says otherwise; Cairo changes with daylight saving). The
owner confirms the schedule. After approval, trigger each once manually **during the window**, then check `SELECT * FROM job_status();` (`succeeded`
for both, `running_now` 0) and `SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 5;`. A first `due-reminders` run sends real
notifications and push messages to production people who have deadlines: announce it before triggering.

### D6 Web app (last)
1. Confirm D4 and D3b are done and accepted, and Vercel production env (`SUPABASE_URL`, anon key only).
2. Merge the branch to `main` (or promote the build). Vercel builds with `npm run build`.
3. Wait for the deployment; open the site in a private window; the service worker updates on the next load (reload twice).

### D7 Post-deployment smoke tests
Section 7, then 24 hours of watching (section 7.5).

### D8 Later steps
* After the web app has been live for about a day and no old cached copy remains: set Kite Drive `'url_tokens' => 'strict'` in `config.php` (separate change, with its own rollback: set back to `legacy`).
* Decide and then apply the Phase 7 open decisions (alert thresholds, retention) as separate changes.

## 6. Secrets and configuration (set before D3)

| Name | Where | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | Edge secret | the production site origin(s); browser calls are refused otherwise |
| `APP_URL` | Edge secret | invitation links |
| `CRON_SECRET` | Edge secret and both cron jobs | at least 24 characters; both jobs answer 503 without it, 403 on mismatch |
| `REMINDER_TZ` | Edge secret | default `Africa/Cairo` |
| `JOB_TIME_BUDGET_MS` | Edge secret (optional) | default 90000; set below the platform limit |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Edge secrets; public key also in Vercel | Web Push (optional: without them push is off) |
| `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL` | Edge secrets | must match Hostinger `config.php` |
| `SETUP_TOKEN` | **must be unset** | bootstrap only |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Vercel build env | anon key only (the build refuses a service-role key) |
| Auth settings | Dashboard / `supabase config push` | signup off, 12-character passwords, SMTP, redirect URLs (`/invitation.html`, `/reset-password.html`) |

## 7. Post-deployment smoke tests

Mark each as **STAGING** (done in phase 2) and **PRODUCTION** (done in phase 3). Use dedicated test accounts; agree in advance which
production checks create data (production should be limited to read-only checks plus clearly labelled test records).

### 7.1 Database (read-only SQL, service role)
```sql
SELECT count(*) AS integrity_rows FROM public.integrity_report();                      -- expect 19
SELECT * FROM public.integrity_report() WHERE n > 0;                                   -- review; a clean local build shows exactly one row: 2 constraints still NOT VALID (known baseline)
SELECT public.format_employee_id(999) AS a, public.format_employee_id(1000) AS b;       -- EMP-999, EMP-1000
SELECT * FROM public.job_status();                                                     -- both jobs after D5
SELECT * FROM public.storage_cleanup_status();
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';                          -- same count as staging
SELECT to_regprocedure('public.task_stats()') IS NOT NULL, to_regprocedure('public.fin_kpis()') IS NOT NULL;
SELECT pg_get_functiondef('public.auth_is_finance()'::regprocedure) !~ 'finance_manager';   -- must be true (executive-only Finance)
```
As the anon and a normal authenticated user (API call or `SET ROLE`): `task_stats()` returns only that user's counts; `fin_kpis()` is
refused for non-executives; service-only functions (`job_status()`, `due_digest_batch(...)`) are refused (HTTP 401/403 or permission denied).

### 7.2 Edge Functions and application (real browser, test accounts)
| # | Check | Expected |
|---|---|---|
| 1 | Sign in as owner, general manager, department manager, employee, finance manager, client | each lands on the right page; employee sees only own/assigned tasks; **finance manager and employee cannot open Finance**; client sees no internal data |
| 2 | Dashboard, Reports, Admin task table, Client Hub, Documents, CRM load | no console errors; pages of 25; "Show more" appears only past the slice |
| 3 | Create a task, assign it, change status, comment | one notification per event, none duplicated; reloading the page changes nothing |
| 4 | Leave request: submit, decide | approvers notified once; requester notified once |
| 5 | Expense claim: submit, decide (executive) | notified once each; amounts only visible to executives |
| 6 | Finance (owner): invoice draft, issue, payment (staging), KPI cards per currency | totals correct, no 500 |
| 7 | Broadcast to a one-person audience with a request id; repeat it | second call reports "sent / duplicate"; the recipient has one notification |
| 8 | `workflow` action `storage.cleanup` as employee and as owner | employee 403, owner 200 |
| 9 | Invite a test employee to a test mailbox; accept the link | activation succeeds once; a second use is refused |
| 10 | Push test (if VAPID configured) | arrives on a phone |
| 11 | Chat: send, react, upload a small file | works; typing indicator visible |
| 12 | Kite Drive: open a client's Files tab; thumbnails; upload a small file; download; ZIP | works over header tokens; no console token errors |
| 13 | Employee list shows `EMP-0xx` for existing people; create one test employee after the release | ID is the next number, three digits below 1000 |
| 14 | Service worker: after a second reload the new build id is active; offline page still works | |

### 7.3 Cron endpoints
Manually POST each endpoint with the headers: HTTP 200 and `{"success":true,...}`; without the secret: 403; with a wrong secret: 403; without `CRON_SECRET` configured: 503.
Then `SELECT * FROM job_status();`, `job_missed_runs(interval '36 hours', ARRAY['due-reminders','retainer-billing'])` returns no rows.

### 7.4 Rollback-readiness check (do not execute rollbacks on production)
`rollback-036.sql`, `rollback-037.sql`, `rollback-038.sql` are present on the operator's machine, and the phase 2 rehearsal result is recorded.

### 7.5 Watch (first 24 hours)
Edge Function error rate and logs for the 12 functions; `integrity_report()` after the first cron cycle; `job_status()` next morning
(both `succeeded`, no `partial`); `storage_cleanup_status()` (pending trending down); Auth failures; Realtime connection counts;
Vercel errors; Hostinger PHP error log.

## 8. Rollback

### 8.1 Decision tree
```
Problem observed
|
+-- Web app broken (white page, wrong data, new JS errors)  ----------> Roll the WEB APP back (8.2 a). DB and functions stay. Safe at any time.
|
+-- A function misbehaves (errors, duplicates, wrong notifications)
|     +-- cron jobs: disable the cron job first (8.2 e), then redeploy the previous version of that function (8.2 b)
|     +-- others: redeploy the previous version of that function (8.2 b)
|
+-- Kite Drive broken (thumbnails, uploads, tokens) -------------------> restore previous PHP (8.2 c); set url_tokens back to 'legacy'
|
+-- Database migration failed halfway (error during D1)
|     +-- STOP. The failing file is a single script: read the error, check R0.3 pre-conditions.
|     +-- Fix the data (never the migration) on a restored copy first; re-apply on production in the next window.
|     +-- If production behaviour is wrong NOW: use the rollback scripts newest-first (8.2 d), then redeploy the previous functions + web app.
|
+-- Data corrupted / wrong rows written after the release
|     +-- Do not roll scripts back. Restore from the D0 backup / PITR to a NEW project, compare, then decide with the owner (8.3).
|
+-- Employee IDs: rollback-038 refuses ('above 999' / 'next number above 999') -> by design: keep 038.
```

### 8.2 Per-layer procedures (reverse of the deployment order: web app, cron, PHP, functions, database)
a. **Web app:** Vercel -> Deployments -> promote the previous production deployment (instant). The previous app works with the new database. Do this **before** rolling back 035/036 (the new app calls `fin_kpis`, `task_stats`).
b. **Edge Functions:** `git worktree`/checkout of the commit that is live, then `supabase functions deploy <name>` for each function in reverse order (`due-reminders`, `retainer-billing`, `broadcast`, then `kite-drive` (D3b), then `workflow`, `chat`, `client-preview`, `accept-invitation`, `invite-employee`). Roll back `kite-drive` before the PHP (c). Old `due-reminders` and `broadcast` work against the 037 database; the new ones do **not** work against a database without 037, so roll the functions back **before** the database.
c. **PHP:** restore the saved `index.php`, `lib.php`, `send.php` and, only if you changed it, the saved live `config.php`. `drive_token_uses` can stay. Set `url_tokens` back to `legacy` if it was switched.
d. **Database** (newest first, only what is needed; each is a script): `rollback-038.sql` (refuses once an ID above 999 exists or the sequence is past 998), `rollback-037.sql` (deletes the job ledger and requeue history), `rollback-036.sql` (roll the web app back first), then the header ROLLBACK text of 035, 034, 033, 032, 031, 030, 029, 028, 027 ... as needed. 015, 017 and 001-019 have no rollback: restore from backup.
e. **Configuration / cron:** disable both cron jobs; unset `JOB_TIME_BUDGET_MS`; revert secrets to the saved values.

### 8.3 What cannot be rolled back safely once data exists
| Change | Why |
|---|---|
| 038 after the 1,000th employee (or sequence past 998) | the old default truncates and collides; the script refuses |
| 037 | rolling back deletes `job_runs` and `storage_cleanup_requeues` history |
| 035 rollback | dropping `lead_stage_history` loses the lead history written meanwhile |
| 034 | invitation tokens are stored hashed; plain tokens cannot be recovered |
| 029 rollback | dropping `storage_cleanup_queue` forgets files waiting for removal; tombstones (`deleted_users`) must not be dropped |
| 025 | notification text rewritten; restorable only from `finance_backup.notifications_pre025` |
| 015, 017 | money moves and legacy invoice load; backup only |
| Notifications, audit rows, invoices, payments, expenses, leave decisions, broadcasts created after the release | business data; a database restore would remove them. Prefer fixing forward or a targeted restore |
| Emails and push notifications already sent (first `due-reminders` run, announcements) | cannot be recalled |
| Re-running 017 | needs **022 > 028 > 033 > 035 > 036 > 037** afterwards (038 is unaffected); skipping 022 re-opens Finance to the finance-manager role |

## 9. Manual actions summary (nothing here is automated by the repository)

Supabase Dashboard: secrets (section 6); two cron HTTP jobs (D5); Auth settings and redirect URLs; backup/PITR; Edge Function logs and alerts
(error rate; none exist yet); delete `setup-admin` if deployed.
Vercel: production branch and environment variables; promote/rollback deployments; domain settings.
Hostinger: upload the three PHP runtime files (never `config.sample.php` over `config.php`); add `'url_tokens' => 'legacy'` to the live `config.php` by hand; confirm writable cache/log folders; optional cleanup cron (not available yet:
no entry point); later `url_tokens = 'strict'`.
Owner decisions: maintenance window; migration 025 approval; cron schedule; alert thresholds and recipients; retention periods.

## 10. Evidence levels at the time of writing

| Item | LOCAL | STAGING | PRODUCTION |
|---|---|---|---|
| All migrations 001-038 in order; 029-038 re-run | verified | not done | not done |
| Rollbacks 036, 037, 038 | verified | not done | not done |
| 017 re-run recovery (022 first) | verified (scratch database) | not done | not done |
| Edge Functions | syntax and source rules only | not done | not done |
| Cron jobs and secrets | not applicable | not done | not done |
| Kite Drive PHP | `php -S` | not done | not done |
| Web app | fake DOM | not done | not done |
| Backup restore | not applicable | not done | not done |
