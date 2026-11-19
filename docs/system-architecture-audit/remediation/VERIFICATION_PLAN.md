# Verification Plan (read-only checks)

**Access in this audit:** none of Supabase (dashboard/CLI/SQL), Vercel or Hostinger was available, so no live check was performed. The only executed check was the in-process RLS suite (`cd supabase/tests && node verify-rls.mjs`): **153 passed, 0 failed**, applying migrations 001-005, 016, 017 plus seeds.

Legend for results: **SC** source-confirmed, **DB** database-configuration confirmed, **RT** runtime confirmed. Everything below is currently **not verified (NV)** unless stated.

All queries are read-only. Run them in the Supabase SQL editor (use a read-only role if available) or via `supabase db query`. Never paste secret values into tickets.

## A. Database configuration (needs: SQL editor access)
| # | Purpose | Query / command | Expected | If different |
|---|---|---|---|---|
| A1 | RLS enabled everywhere (011 check) | `SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;` | no rows | tables exposed: fix immediately (ARC-01 family) |
| A2 | anon has nothing | `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='anon';` | no rows | revoke |
| A3 | `ceo` role exists? (ARC-01) | `SELECT id, name, is_active FROM roles WHERE name IN ('ceo','owner','general_manager','finance_manager','accountant','hr_manager');` | note which exist | if `ceo` exists apply P0 interim patch |
| A4 | Who holds privileged roles and who assigned them | `SELECT p.email, r.name, ur.assigned_by FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN profiles p ON p.id=ur.user_id WHERE r.name IN ('super_admin','owner','ceo','general_manager','finance_manager','accountant','hr_manager') ORDER BY r.name;` | only intended people | investigate unexpected holders |
| A5 | Policy count matches repo (175 + 7 dynamic) | `SELECT count(*) FROM pg_policies WHERE schemaname IN ('public','storage');` | close to repo count (compare list with `docs/system-architecture-audit/system-graph/system-graph.json`) | drift: live differs from migrations (empty migration history) |
| A6 | Trigger instances (48 expected) | `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal;` | ~48 | missing triggers (e.g. blank_money, guards) |
| A7 | SECURITY DEFINER functions pin search_path | `SELECT proname, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND prosecdef;` | each has `search_path=` | fix any without |
| A8 | Database time zone (FUN-02) | `SHOW timezone;` | `UTC` means the bug is live; `Africa/Cairo` means mitigated | |
| A9 | Asset paths vs uploader (SEC-06) | `SELECT count(*) FROM assets WHERE split_part(storage_path,'/',1) <> uploaded_by::text;` | 0 | list rows before adding the CHECK |
| A10 | Leave and expense data quality (DAT-04, DAT-06) | `SELECT count(*) FROM leave_requests WHERE end_date < start_date;` and `SELECT currency, count(*) FROM expenses GROUP BY 1;` | 0 invalid; one expected currency | cleanup plan |
| A11 | Duplicate DMs (DAT-08) | `WITH pairs AS (SELECT c.id, string_agg(cm.user_id::text, ',' ORDER BY cm.user_id) AS pair FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.type='direct' GROUP BY c.id) SELECT pair, count(*) FROM pairs GROUP BY pair HAVING count(*)>1;` | no rows | merge duplicate conversations before adding a unique pair key |
| A12 | Orphan storage objects (DAT-09) | `SELECT o.bucket_id, count(*) FROM storage.objects o WHERE o.bucket_id='chat-media' AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id::text = split_part(o.name,'/',1)) GROUP BY 1;` | 0 | clean-up job |
| A13 | Largest tables and growth (OPS-03) | `SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;` | notifications/audit_logs sizes | retention |
| A14 | Slowest queries (PERF-02) | `SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 15;` (extension must be enabled) | no seq-scan heavy RLS queries | add indexes |
| A15 | Indexes supporting RLS predicates | `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('tasks','task_assignees','user_departments','conversation_members','user_roles');` | indexes on user_id/task_id/assigned_to | add |
| A16 | Client delete behaviour (DAT-03) | On a **scratch copy**: create client with issued invoice and retainer plan; `DELETE FROM clients WHERE id=...;` | error (RESTRICT/guard) | orphan if it succeeds |

## B. Scheduled jobs (needs: SQL editor; pg_cron enabled) — OPS-01
| # | Query | Expected |
|---|---|---|
| B1 | `SELECT jobid, schedule, command, active FROM cron.job;` | entries for due-reminders and retainer-billing (or none if scheduled via the dashboard HTTP cron: check the dashboard Integrations > Cron list instead) |
| B2 | `SELECT jobid, status, start_time, return_message FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;` | daily success rows |
| B3 | Evidence from data | `SELECT max(created_at) FROM notifications WHERE type='due_digest';` and `SELECT max(created_at) FROM invoices WHERE kind='retainer';` | within 1 day / within the current month |

## C. Edge Functions and secrets (needs: Supabase CLI logged in)
| # | Command | Expected |
|---|---|---|
| C1 | `supabase functions list` | 12 functions; `setup-admin` should **not** be deployed after bootstrap |
| C2 | `supabase secrets list` (names only) | `ALLOWED_ORIGINS`, `APP_URL`, `CRON_SECRET`, `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL`, VAPID keys; `SETUP_TOKEN` absent |
| C3 | Function logs for errors in the last 7 days (dashboard) | no recurring 5xx |
| C4 | Auth settings (dashboard) | sign-ups disabled, password >= 12, email confirmations on |

## D. Vercel / web host (needs: Vercel access or curl)
| # | Command | Expected |
|---|---|---|
| D1 | `curl -sI https://<prod>/ | grep -i -E "content-security|strict-transport|x-content-type"` | CSP, HSTS, nosniff present |
| D2 | `curl -s https://<prod>/env.js` | URL + anon key only (no service_role) |
| D3 | `curl -I https://<prod>/supabase/seed.sql` and `/docs/security.md` | 404 |
| D4 | `vercel env ls` (names only) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, optional VAPID/ICE |

## E. Hostinger / Kite Drive (needs: hosting panel or SSH) — SEC-02, OPS-03, PERF-04
| # | Check | Expected |
|---|---|---|
| E1 | `php -v`, `php -i | grep -E "post_max_size|upload_max_filesize|memory_limit|max_execution_time"`, `php -m | grep -E "gd|zip|fileinfo"` | PHP >= 8.1; limits adequate; gd/zip/fileinfo present |
| E2 | `.htaccess` honoured (mod_rewrite/AllowOverride) | `curl -I https://<drive>/uploads/anything` goes through file.php (302/403, never a direct file) |
| E3 | `api/config.php` permissions and contents (do not print secret) | not web-readable; `allowed_origins` lists only the SPA origins |
| E4 | Access log search | `grep -c "token=" access.log` > 0 confirms SEC-02 exposure window |
| E5 | `du -sh api/_log api/_thumbs api/_chunks` | sizes bounded; trend upward confirms OPS-03 |
| E6 | Backups | evidence of scheduled backups for `uploads/` and MySQL (OPS-04) |

## F. Behavioural tests on **staging only**
| Issue | Test |
|---|---|
| SEC-01 | 200 concurrent `feedback` calls on a staging plan; count rows and notifications |
| ARC-01 | Role-matrix script: for each role call invite-employee/employee.update/expense.decide/broadcast/kite-drive link; compare with the intended matrix |
| DAT-05 | Inject a failure after the delete in role change; confirm role survival after FX-06 |
| FUN-01 | Playwright with a 3 s delayed network: navigate Chat then Tasks quickly; assert final DOM and channel count |
| FUN-02 | `SET timezone='UTC'` with fixed `now()` at 23:30 UTC and call `fin_payment_add` with the Cairo date |
| DAT-04 | Insert invalid leave/message/expense rows as a normal user; expect rejection after FX-07 |

## G. Reporting
For each check record: date, who ran it, environment, result, and issue ID. Update the issue status to **Verified** only with that record. Do not store secret values.
