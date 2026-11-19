# Phase 6: performance and request optimization

Migration `036_performance.sql`, frontend request changes, and the evidence. Everything here was measured on a throwaway local
PostgreSQL 18 (embedded-postgres, Windows) with the complete migration chain, never on staging or production. Absolute
milliseconds on a managed database will differ; the buffer-hit counts and the ratios are platform independent.

## What was wrong (confirmed, not theoretical)

Every task query evaluated a `SECURITY DEFINER` helper once **per row** (`auth_can_view_task(id)`, `auth_is_admin()`, `auth_is_finance()`, ...).
PostgreSQL cannot inline such a function, so a page of 20 tasks read the whole table and ran the helper on all of it. 117 of the 165
policies called a column-free helper per row.

## Result (60,000 tasks, 300,000 messages, 100,000 notifications, 150,000 comments, 20,000 attachments, 5,000 invoices)

Same dataset, same users, same queries, `EXPLAIN (ANALYZE, BUFFERS)`, median after a warm-up run. `npm run test:perf` with `SCALE=1`.

| Query | User | Before | After | Buffer hits before -> after |
|---|---|---|---|---|
| tasks page 1 (20 rows, newest first) | employee | 15,966 ms | 1.1 ms | 1,175,649 -> 1,062 |
| | department manager | 20,532 ms | 0.6 ms | 1,157,868 -> 147 |
| | admin | 9,183 ms | 0.3 ms | 841,503 -> 33 |
| tasks `count(exact)` for the pager | employee / dept manager / admin | 15,242 / 19,460 / 8,766 ms | 11.6 / 11.4 / 8.3 ms | 643x - 762x fewer |
| dashboard: every task (status, department) | employee / admin | 15,392 / 8,701 ms | 12.2 / 8.3 ms | 643x / 556x fewer |
| dashboard: `in_progress` count | employee / admin | 2,207 / 1,270 ms | 3.8 / 3.4 ms | 92x / 80x fewer |
| documents: all task attachments joined to tasks | employee / admin | 5,263 / 5,862 ms | 48 / 63 ms | 5x / 8x fewer |
| finance: `fin_kpis()` | owner | 406 ms | 2.8 ms | 25,245 -> 249 |
| finance: invoices page 1 with client | owner | 462 ms | 3.8 ms | 28,115 -> 275 |
| chat: last 50 messages (member) | employee | 8.4 ms | 8.3 ms | unchanged (not affected) |
| notifications: unread count | employee | 0 ms | 0 ms | unchanged |

Pagination: 2,400 pages for an admin, 364 for a department manager, 77 for an employee. Page 1, 2, 3, a middle page, the second last and
the last page all answer in 1-34 ms.

Concurrency (8 users, each running page + count + stats at the same time): wall time **79,069 ms -> 206 ms**, p95 79,068 -> 206 ms.
32 simultaneous users after the change: wall 593 ms, p95 577 ms, every request correct.

Request counts (`npm run test:requests`, the same tests run against the previous frontend fail 31 checks):

| Screen | Before | After |
|---|---|---|
| Dashboard, first load | 8 requests (4 of them scan every task) | 5 |
| Dashboard, someone changes a task | 8 | 2 |
| Dashboard, someone changes a department | 8 | 1 |
| Client hub, first load | 5 requests (every task, project and campaign into the browser) | 3 (one database call for all per-client figures) |
| Client hub, a task / project / campaign changes | 5 | 1 |
| Reports | every task (`select *`) | one page of 25 + one grouped-counts call |
| Admin task table | every task | one page of 25 |
| Documents | every asset and every attachment | newest 400 of each + exact total, "Show 400 more" |
| CRM pipeline | every lead | newest 500 + exact total, "Show 500 more" |
| A burst of 50 Realtime events | up to 50 refreshes, possibly overlapping | exactly 1 refresh, never two at once |

## What changed

### Migration 036 (additive, reversible)

1. **Row-level security cost (PERF-02).** 143 policies were rewritten mechanically:
   * a column-free helper call or `auth.uid()` becomes `(SELECT ...)`: PostgreSQL evaluates it once per statement (an InitPlan);
   * `tasks_select` uses three `SECURITY DEFINER` id-set helpers (`auth_managed_department_ids()`, `auth_assigned_task_ids()`,
     `auth_managed_project_ids()`) that return the caller's ids once per statement;
   * `auth_can_view_task(<column>)` in the policies of task children (comments, attachments, links, checklists, time entries, handoffs,
     activity, assignees) becomes `EXISTS (SELECT 1 FROM tasks WHERE tasks.id = <column>)`: the tasks policy decides, as the function did.
   * The old helpers are **not** dropped or changed. Policies that pass a column to a helper (`auth_is_dept_manager(department_id)`,
     `auth_can_see_client(id)`, `auth_can_view_conversation(conversation_id)`) are unchanged.
   * The policy text is generated from the real post-035 policies by `supabase/tests/tools/gen-036-policies.mjs` (reviewable static SQL).
2. **Indexes** (`created_at DESC, id`): `tasks`, `invoices`, `expenses`, `task_attachments`, `assets`, `leads`. With the policy change the
   admin tasks page walks `idx_tasks_created_desc` and stops after 20 rows. On a large live table run each `CREATE INDEX` once by hand with
   `CONCURRENTLY`. **No index was dropped.**
3. **Aggregates** (SECURITY INVOKER: RLS decides what each person counts, exactly as when the browser summed the rows it could read):
   `task_stats()` (counts by status, priority and active department) and `client_task_stats(date)` (open / done / late tasks and active
   projects per client; the browser still passes "today", so the lateness rule is unchanged).

### Frontend

* `realtime-service.js`: a burst of changes is one refresh (debounce + a max wait so a steady stream cannot starve it); refreshes are single
  flight (changes during a refresh are answered by exactly one more); the callback receives the Set of changed tables (`'*'` for polling and
  for the tab becoming visible); a page that was left never starts another refresh. A callback that ignores the argument still works.
* Dashboard, client hub, documents and CRM refresh only the part the changed tables can affect. Charts on the dashboard and reports are
  created once and updated or destroyed (before: a new chart on every refresh).
* The reports CSV export reads in chunks of 1,000 (cap 50,000, with a notice) instead of one unbounded request.

## Security and compatibility (what the tests prove)

`npm run test:perf` applies 036 to a database that already holds the data and compares **before and after**:

* **SELECT:** for 17 users and anon, on all 63 tables that has a rewritten policy, the visible rows are byte-for-byte identical
  (row count and md5 of all rows). Roles: super_admin, owner, general_manager, department_manager (two departments), project_manager (two),
  team_leader, hr_manager, finance_manager, client, inactive employee, role-less user, collaborator via `task_assignees`, creator, assignee, unrelated employees.
* **INSERT / UPDATE / DELETE:** 78 statements per user (1,326 outcomes) (comments, links, attachments, assignees, tasks, leads, clients, projects,
  departments, expenses, vendors, budgets, invoices, settings, money figures, notifications, messages, leave) have the identical outcome
  (allowed with the same row count, or denied with the same error code), and the probes cover both allowed and denied cases.
* **Structural proof:** undoing the rewrite on the deparsed text of every other policy gives the original text.
* **Negative cases stated explicitly:** client-role, role-less and inactive users see no task; anon is denied tasks and invoices; employee,
  finance_manager, HR and PM see no invoice; owner and super_admin see every invoice; a Dept1 manager cannot see an unrelated Dept2 task;
  a project manager cannot see another manager's project task; tasks still cannot be written through the API; invoices still cannot be written directly.
* **Harness self-test:** a deliberately broken tasks policy is detected by the same comparison.
* The two aggregates are SECURITY INVOKER; `anon` cannot call them; a client-role or role-less user counts nothing.
* `task_stats()` and `client_task_stats()` equal the old browser-side computations for several users.
* Pages of the same task list before and after the migration contain the same tasks (first page, last page, totals).
* Phase 1-5 suites all pass with the migration in the chain (`test:integrity` runs it twice).

If a policy could not be proven equivalent it would have been left unchanged; none failed.

## Rollback

```
psql -f supabase/maintenance/rollback-036.sql
```

Restores the exact original text of all rewritten policies, drops the helpers, aggregates and indexes. No data is touched.
`npm run test:perf` (section 8) runs the rollback, checks that every policy is back to its exact original text, then applies 036 again.
If 017 is ever re-run it re-creates the finance policies in their slower per-row form and with the pre-022 finance access: re-apply 022 -> 028 -> 033 -> 035 -> 036 -> 037 (in that order; re-applying 036 alone is not enough).
The frontend can be rolled back on its own: the old browser code still works against the new database (the old queries are still valid).

## Not done / deferred

* **Eight redundant indexes** (kept, to be removed in a separate clean-up): `attendance_records` (`uq_user_attendance_date` = `idx_attendance_user_date`),
  and prefix-redundant `idx_content_assets_plan`, `idx_message_reactions_message`, `idx_messages_convo`, `idx_project_departments_project`,
  `idx_task_assignees_task`, `idx_user_departments_user`, `idx_user_roles_user`.
* **Module lazy-loading and `chart.umd.js`** (62 unbundled module files, 750 KB, all loaded at boot): deferred until real-browser measurements justify it.
* The documents join (`task_attachments` x `tasks`) is 5-8x cheaper but still reads about 80k buffers for 20,000 attachments because the whole table is read; it is now bounded to the newest 400 rows per list on the screen.
* Policies that pass a row column to a helper (`auth_can_see_client`, `auth_can_view_conversation`, `auth_can_view_project`) are unchanged: they are bounded by small tables or by an index on the conversation.
* Notification fan-out (PERF-01 / FX-11), storage and media costs, connection limits and browser render times were not measured here.
* The client detail page still reads one client's tasks and files in full (bounded by the client).

## Reproduce

```
cd supabase/tests
npm run test:perf                       # default dataset (6,000 tasks): equivalence, before/after, pagination, concurrency, rollback
SCALE=1 BENCH_ONLY=1 BENCH_JSON=out.json node verify-perf.mjs    # the 60,000-task dataset above (measurements only)
npm run test:requests                   # frontend request counts; FRONTEND_DIR=<old checkout>/ for the "before" run
```
