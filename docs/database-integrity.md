# Database integrity (Phase 3: migrations 028 to 033)

This page is the operator's reference: the rules the database now enforces, the order to apply the migrations, how to roll each one back,
the detectors to run, and the business decisions that are still open. Applied manually, one file at a time, on staging first;
never `db push` on live (the live migration history is empty).

## Order

```
017  ->  022  ->  023 ... 027  ->  028 finance integrity  ->  029 history protection  ->  030 HR  ->  031 approvals + expenses
                                                         ->  032 atomic operations   ->  033 hygiene (last)
```

Every file is idempotent. **If 017 is ever re-run, re-apply 028 and then 033** (017 re-creates the original bodies of the finance
functions and the 7-argument `fin_payment_add`; 028 restores the Phase 3.A versions, 033 restores the studio-date and
operator-only-switch versions). The sequence 017 -> 028 -> 033 is tested (`verify-integrity.mjs`, section 14) and must end with
exactly one `fin_payment_add`.

A constraint or unique index that existing data cannot satisfy is **not forced**: the migration prints a NOTICE with the count and leaves
the constraint `NOT VALID` (still enforced for every new write) or skips the index. Clean the data, then re-run the migration.
`SELECT * FROM integrity_report()` (service role) lists everything that is still open.

## What is enforced

| Migration | Rule |
|---|---|
| 029 | An employee with history (attendance, leave, chat, HR documents, task comments / time entries, audit or activity records, finance audit, expenses, tasks created) cannot be deleted: deactivate. Deleted profiles leave a tombstone (`deleted_users`); `audit_logs` / `task_activity_logs` keep `actor_id` + `actor_label`. Tasks, projects, clients, departments with billing / work history cannot be deleted (archive: task Cancelled, project archived, client Inactive, department deactivated); the message never reveals finance details. Deleting a row queues its Storage file in the same transaction (`storage_cleanup_queue`); `drainStorageCleanup()` removes it afterwards and retries failures (the daily job and task / plan / message deletes call it). |
| 030 | Attendance: server clock for check-in / check-out, studio date, computed hours, one close, no re-open, check-out after check-in. Leave: DB-counted days, end >= start, no overlap (race-safe), balances (below). |
| 031 | Content plan: approval and its evidence row are one transaction; approval is invalidated by any change to approved content (audited); a visual / feedback row must belong to the post's own plan. Expenses: draft -> submitted -> approved / rejected, approved -> paid; atomic decisions; currency default EGP; `budgets.spent` is derived. |
| 032 | Department links change in one transaction, one primary per person. A record and its money figure are saved together; a figure follows its record. Kite Drive links are created through an intent (crash-safe, retry adopts). Atomic reaction toggle and channel membership; one reminder per person per day; broadcasts recognised by request id; one pending invitation per e-mail. |
| 033 | Finance uses the studio's business date. `audit_logs` append-only; TRUNCATE blocked on audit and finance tables. A supporting index for every foreign key. `app.migrating` works only for a database operator. |

## Business rules that were defined (defaults chosen from existing behaviour)

* **Studio time zone**: `company_settings` key `studio_timezone` (JSON string), default `Africa/Cairo` (the same default as the scheduled functions).
* **Leave days** = calendar days start..end inclusive (what the app already counted). Weekends and public holidays are **not** excluded.
* **Leave balance** = `leave_types.default_days` per calendar year, available in full on 1 January. No accrual, no proration, no carry-over.
  `default_days = 0` = no limit tracked. Pending requests reserve days; rejected / cancelled release them; approving re-checks.
* **Budgets**: `spent` = approved + paid expenses of the same studio-date year, in the finance currency, inside the budget's department / project scope.
* **Approval invalidation**: editing post content (title, date, time, type, platform, pillar, objective, idea, caption, links, position), adding / removing / reordering posts or visuals, or editing the plan title / subtitle / direction / accent moves an approved plan to `in_review`. Publishing does not.

## Decisions still needed (not guessed)

1. **Working days for leave**: should weekends / public holidays be excluded from the day count? (today: no)
2. **Accrual, proration, carry-over** of leave: keep the flat annual entitlement, or define the studio's policy?
3. **Old expenses with currency `USD`**: they were entered through a form labelled EGP. Were they EGP? (not rewritten; reports now show them as USD)
4. **Budget figures typed by hand** before 031: keep them, or replace them with the derived figure? (`budget_reconciliation()` lists the differences; nothing was rewritten)
5. **Legacy employees without a clean history** are simply protected; no purge path exists. If a real purge is ever needed it must be an explicit, audited, executive-only operation.

## Detectors (read-only, service role)

`integrity_report()` (all of them), `fin_reconcile_invoices()`, `money_figure_orphans()`, `department_link_drift()`, `drive_link_orphans()`,
`storage_cleanup_status()`, `hr_open_attendance()`, `budget_reconciliation()`, `employee_history(user)`, `deletion_blockers(entity, id)`.

## Rollback

Each migration's header has its exact rollback statements; none deletes business data. Rollback order is the reverse of the apply order
(033 first). Rolling back 033 leaves the 017 / 028 function bodies in place: restore them by re-running 017 and then 028, and **do not**
re-run 033. `maintenance/remove-test-data.sql` switches the audit trigger off for its one audit delete and back on.

## Tests

`npm run test:integrity` (real PostgreSQL, the whole chain 001 -> 033, concurrency, a legacy-data database), `npm run test:finance-concurrency`,
`npm run test:concurrency` (Phase 1), `npm test` (RLS + roles, including the Edge Function behaviour).
