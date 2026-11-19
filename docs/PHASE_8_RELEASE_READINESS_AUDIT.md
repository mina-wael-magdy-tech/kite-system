# Phase 8: Release readiness audit (read-only)

Branch `fix/phase-3-remaining-integrity`, commit `fdfabb4`. Scope: Phases 0-7 and the employee-ID hotfix (migration 038).
This document is an audit only. No application code, SQL, migration, Edge Function, PHP or frontend file was changed for it.
The step-by-step procedure is in `docs/PHASE_8_DEPLOYMENT_RUNBOOK.md`.

## 0. How to read the evidence

Three levels are used everywhere. Nothing in this repository can prove the second or third level.

| Level | Meaning | Status of this release |
|---|---|---|
| **LOCAL** | Run on a throwaway local PostgreSQL / PHP built-in server / fake DOM, from this repository | Done (section 3) |
| **STAGING** | Run against a Supabase staging project, Edge Functions in the real runtime, a Hostinger test copy, a real browser | **Not done. Never done for any phase in this branch.** |
| **PRODUCTION** | Observed on the live system | **Not done. The live state is not known** (see P0-01) |

No staging or production system was accessed for this audit. Where this document says "live", it means what the repository and the
saved project notes say, not an observation.

## 1. Executive verdict

**NOT READY for production. Ready for a staging rehearsal.**

The code is in a good local state: every automated suite passes (section 3), every migration has an additive design, 036-038 have
tested rollback scripts, and the working tree contains only the three expected untracked paths. But a production release would
combine 38 migrations, 12 Edge Functions, 4 PHP files and a large frontend change on a system whose current schema and function
versions are **unknown**, with **no staging verification, no Deno-runtime verification, no configured/verified cron jobs, and no
confirmed backup/restore**. The four blockers below must be cleared first.

| # | Blocker (must be resolved before production) |
|---|---|
| B1 | Establish the live starting state: which migrations (020-038) are applied, which Edge Functions and PHP files are deployed, what policies exist (P0-01, P1-04) |
| B2 | A rehearsal of the full sequence on a staging Supabase project restored from a production backup, including the Edge Functions in the real runtime (P0-02, P0-03) |
| B3 | A verified backup and a tested restore (PITR if available) taken immediately before the release (P0-04) |
| B4 | Correct the documented recovery sequence after a re-run of migration 017 (it omits migration 022) and the `supabase db push` instruction in `docs/deployment.md` (P0-05, P1-01). Do not merge this branch to `main` before the database and functions are ready, because `main` is the deployed branch (P0-06) |

## 2. What is in this release

`main` is `5e951e1`. The branch is **14 commits ahead** (92 files, +12,786 / -776) and has **no upstream** (never pushed).

| Commit | Phase | Layers touched |
|---|---|---|
| `c9599f2`, `c47dc0e`, `a50ce2b` | ARC-01 role tiers, executive-only Finance, last super-admin guard | DB (020-025), Edge Functions |
| `a52f30e`, `b0e1be5` | Phase 2: client asset scoping, storage path binding, plan-asset integrity | DB (026, 027), frontend, Edge Functions |
| `c6a7485`, `22c31c0` | Phase 3.A finance integrity, payment idempotency | DB (028), Edge Functions (`finance`) |
| `29c4cd6` | Phase 3.B-3.E history protection, HR/approval integrity, atomic operations, hygiene | DB (029-033), Edge Functions |
| `bca603e` | Phase 4 Kite Drive tokens, router/module lifecycle, atomic activation | DB (034), Edge Functions, **PHP**, frontend |
| `c591499` | Phase 5 business correctness | DB (035), frontend |
| `af6d4f8` | Phase 6 performance | DB (036), frontend |
| `96fd148` | Phase 7 background jobs | DB (037), Edge Functions, docs |
| `ef2f905`, `fdfabb4` | Employee-ID hotfix and its rollback guard | DB (038) |

## 3. LOCAL test evidence (all run from this repository, last runs after the final SQL change)

| Suite | Result | What it proves | What it cannot prove |
|---|---|---|---|
| `verify-rls` | 203 passed | RLS attack scenarios on real PostgreSQL | Real Supabase Auth/PostgREST/Storage behaviour (stubs) |
| `verify-roles` | 1557 passed | Role matrix, Edge Function source rules | The functions running in Deno |
| `verify-integrity` | 397 passed | The full chain 001-038, run twice for 029-038, detectors, recovery order | Live data |
| `verify-concurrency` | 91 passed | Concurrent access to shared rows | - |
| `verify-finance-concurrency` | 79 passed | Payment idempotency, locking | - |
| `verify-frontend` | 52 passed | Router/module lifecycle with a counting fake DOM | A real browser |
| `verify-requests` | 62 passed | Request counts, Realtime coalescing with a fake client | Real network / Realtime |
| `verify-drive` | 97 passed | Kite Drive API under `php -S` | Hostinger PHP limits, real MySQL |
| PHP `lib_test.php` | 63 passed | Token and upload helpers | - |
| `verify-perf` | 177 passed (112 at 60k-task scale, measurements) | RLS equivalence, before/after plans | Managed-Postgres absolute timings |
| `verify-background` | 160 passed | 5,000-user digest, concurrent workers, broadcasts, cleanup, rollback | The Edge Functions themselves |
| `verify-employee-id` | 64 passed | ID boundaries, concurrency, rollback guard | - |

There is **no CI** (`.github` does not exist): nothing runs these automatically. Edge Function files are checked for TypeScript
syntax (esbuild) and by source assertions only; **no Deno or Supabase runtime was available**.

An additional local experiment for this audit (scratch database, nothing in the repository changed) established the exact recovery
sequence after a re-run of 017: see P0-05.

## 4. Findings

Severity: **P0** blocks production. **P1** must be fixed or consciously accepted before production. **P2** should be scheduled.
"Decision" = needs a human/business decision, not only work.

### P0

**P0-01 The live starting state is unknown.**
Evidence: saved project note: on 2026-11-05 `supabase migration list` on the live project showed 001-019 as unapplied although the
database is in use (no migration history table). Nothing in the repository records which of 020-038 are applied. The audit baseline
`docs/system-architecture-audit/phase-0/SCHEDULER_BASELINE.md` says live state was not accessible. Impact: the correct start point,
which Edge Functions are old, and whether the migrations' prerequisites hold cannot be determined. Action: run the read-only
inventory in runbook step R0 on production and on staging. Decision: no.

**P0-02 Nothing has been verified on staging.**
Evidence: no STAGING-level result exists for any phase. Impact: real Supabase Auth invitation links, Storage policies, PostgREST row
caps, Realtime and Edge Function behaviour (including the new `due-reminders`, `broadcast`, `retainer-billing`, `workflow`) have never
run. Action: full rehearsal (runbook phase 2) on an **isolated** staging project. The rehearsal itself is a hazard if it is not isolated:
the jobs send e-mail, push and in-app notifications. Required before anything is triggered: sandboxed or disabled outbound e-mail, staging-only
secrets and **new VAPID keys**, a separate Kite Drive test copy with no real client files, dedicated test accounts, a sanitized production-derived
copy (e-mails replaced, `push_subscriptions` emptied, invitations cleared) or synthetic data, an explicit prohibition on notifying real
production users, and cron left unscheduled on staging (runbook 2.1 and 2.2). Production cron activation is a separate, owner-approved step (runbook D5).
Decision: no (owner approval for the production cron step).

**P0-03 Edge Functions are unverified in a real runtime.**
Evidence: no Deno; functions checked by esbuild syntax pass and source assertions. The four functions changed in Phase 7 contain new
control flow (`due-reminders` batching and time budget, `broadcast` claim/resume, ledger calls). Unverified assumption: the
`JOB_TIME_BUDGET_MS` default (90,000 ms) is below the platform's Edge Function wall-clock limit for the project's plan. Impact: a
function killed by the platform leaves its ledger run in `running` (it is visible, but nothing alerts). Action: staging run of every
function; confirm the platform limit; set `JOB_TIME_BUDGET_MS` below it. Decision: no.

**P0-04 Backup and restore are not verified.**
Evidence: `docs/deployment.md` section 4 lists backups as a checklist item ("test a restore"); no evidence it was done. Migrations 025
(rewrites notification text), 029 (backfills audit actors, adds delete guards), 034 (column grants), 036 (rewrites 143 policies), 038
(changes a default) change live behaviour or data. Action: take and restore-test a backup/PITR point immediately before step D1.
Decision: owner approves downtime/maintenance window.

**P0-05 The documented recovery sequence after re-running migration 017 is incomplete and unsafe.**
Evidence (LOCAL experiment on a scratch database, full chain 001-038, then 017 re-run, comparing every public function, policy and
trigger by hash): re-running 017 reverts `auth_is_finance()` to the 017 definition and re-creates the 017 finance policies and the
`clients_select_finance` policy. The sequence documented in `docs/database-integrity.md`, the 035 header and the 036 notes
(**028 -> 033 -> 035 -> 036 -> 037**) leaves **two differences**: `auth_is_finance()` (017's wider definition, which grants Finance to
the finance-manager / accountant roles that migration 022 removed) and an extra `clients_select_finance` policy. That is a
confidentiality regression on financial data. Results:

| Sequence after a 017 re-run | Differences from the intended state |
|---|---|
| 028 > 033 > 035 > 036 > 037 (as documented before the documentation pass that followed this audit) | 2 (`auth_is_finance()`, `clients_select_finance`) |
| **022 > 028 > 033 > 035 > 036 > 037** | **0** |
| 028 > 033 > 035 > 036 > 037 > 022 (022 last) | 3 (022 overwrites 036's rewritten policies) |
| 022 > 028 > 033 > 035 > 036 > 037 > 024 | 4 (024 reverts the asset policies; do not re-run 024) |

Action: correct the documentation to the sequence with **022 first**, then 028, 033, 035, 036, 037 (038 is not
affected). Decision: no. Until corrected, nobody should re-run 017.

**P0-06 Merging to `main` may deploy the frontend before the database is ready.**
Evidence: `main` is the branch noted as live; `docs/deployment.md` describes a Vercel build from the repository; the SPA calls
`task_stats`, `client_task_stats` (036), `fin_kpis`, `fin_client_balances` (035), `create_entity_with_figure`,
`update_entity_with_figure`, `set_client_departments` (032). Impact: if the web app deploys first, the dashboard, reports, client hub
and finance KPIs fail. Action: do not merge until the database and functions are in place, or deploy from a branch/preview
(runbook phase 3). Confirm in Vercel which branch is auto-deployed (not observable here).

### P1

**P1-01 `docs/deployment.md` told operators to run `supabase db push`** (section 5, "Releasing changes"). On the live project this is
forbidden: its migration history is empty, so `db push` would try to apply every migration from 001. It also stated "No build step"
although a Vercel build (`npm run build`) is required. **Corrected in the documentation pass that followed this audit** (manual, one-file-at-a-time
migrations; Vercel production build; the 017 recovery sequence). Decision: no.

**P1-02 Scheduled jobs are not in version control and their live state is unknown.** `due-reminders` and `retainer-billing` exist only
as Dashboard cron entries. If `retainer-billing` is missing, no retainer draft is created and no invoice becomes overdue
(`fin_mark_overdue()` has one caller, that function). If `due-reminders` is missing, no digest, no storage-cleanup retry and no
invitation expiry run. See section 8 for the exact jobs. Action: create/verify by hand (runbook phase 5); decide alerting.

**P1-03 No alerting or missed-run detection is wired.** Phase 7 added the `job_runs` ledger and read-only detectors
(`job_status()`, `job_missed_runs(age, expected)`, `job_stuck_runs(age)`), but nobody is notified and no thresholds exist (deliberately
left to the owner). Failure detection is a manual query. Decision: yes (thresholds, recipients).

**P1-04 Policy drift on the live database is unknown.** Migration 036 rewrites 143 policies by name with text generated from the
repository chain (`gen-036-policies.mjs`). If a live policy was edited by hand, 036 silently overwrites it; `rollback-036.sql`
restores the repository's originals, not the live text. Action: before 036, export `pg_policies` from production and diff it against
a database built from migrations 001-035 (runbook R0). Decision: no.

**P1-05 Data pre-conditions of the constraint/index migrations are unverified on live data.**
* 028, 029, 031, 033, 035 add constraints (several `NOT VALID` then validated, or left `NOT VALID`); a validation can fail on existing
  rows. `integrity_report()` counts constraints still `NOT VALID`.
* 032 creates unique indexes (`uq_user_primary_department`, `uq_invitation_pending_email`, `uq_notifications_dedupe`,
  `uq_broadcasts_request`) that fail if live data already holds duplicates.
* 033 (section 4) creates an index for every foreign key and 036 creates six `created_at` indexes with plain `CREATE INDEX`, which
  blocks writes to that table while it builds. Small tables: seconds; the `tasks`, `notifications`, `messages` volumes on live are
  unknown.
Action: run the read-only duplicate/validity queries in runbook R0 on a restored copy; for large tables create the 036 indexes by hand
with `CONCURRENTLY` first (the migration then skips them: `IF NOT EXISTS`).

**P1-06 Several migrations change existing data or grants and have no pure rollback** (section 5.3): 015, 017 (legacy invoice load),
025, 029, 034, 035/036/038. See the rollback table; after the release has run, a database rollback cannot undo created data.

**P1-07 Frontend tests use a fake DOM; no real-browser test exists** (`docs/phase4-release.md` says the same). Unverified:
service-worker update path, CSP with the new request patterns, Realtime coalescing under real network, chart updates, pagination UI,
"Show more" in Documents/CRM, mobile layouts. Action: manual browser pass in staging (runbook phase 4), ideally a Playwright smoke
test later.

**P1-08 Kite Drive PHP is unverified on the real host.** Three PHP runtime files changed in Phase 4 (`index.php`, `lib.php`, `send.php`) plus the
template `config.sample.php` (not a runtime file, see section 9); tested with `php -S` only. Not exercised: real MySQL, Hostinger `memory_limit`/`max_execution_time`, GD limits,
the real file-locked tokens end to end, the `url_tokens` `legacy` -> `strict` switch. It is not known whether `bca603e` was ever deployed
to Hostinger. `api/config.php` (secret, DB credentials) is not in the repository. Action: see section 9 and runbook phase 4.

**P1-09 `setup-admin` is still in the repository.** `config.toml` declares it; `docs/deployment.md` says to delete it after
bootstrap. Whether it is deployed live, and whether `SETUP_TOKEN` is unset, is unknown. Action: confirm it is not deployed in
production (runbook R0, step D3).

**P1-10 The Dashboard-held secrets and variables required by the functions are not recorded anywhere as a verified set.** See
section 7. A missing `CRON_SECRET` disables both jobs (HTTP 503); a missing `ALLOWED_ORIGINS` / `APP_URL` breaks browser calls and
invitation links; `KITE_DRIVE_API_SECRET` must match Hostinger's `config.php`.

**P1-11 The old-version compatibility of the Edge Functions during a staged rollout is asserted, not tested.** For example the new
`due-reminders` and `broadcast` require 037 and fail before it; the old ones work with 037 (stated in `docs/background-jobs.md`, not
tested against an old function build).

### P2

* **P2-01** `config.toml` has no `[functions.*]` entries for `broadcast`, `finance`, `retainer-billing`. The platform default is
  `verify_jwt = true`, which the cron calls satisfy (anon Bearer header), but the behaviour should be explicit. `client-preview`
  deliberately has `verify_jwt = false` (public share link): confirm its token checks in staging.
* **P2-02** Phase 7 decisions still open: alert thresholds/recipients; retention periods (notifications, activity logs, finance audit, completed
  cleanup rows, Drive log); task soft-delete; broadcast stale-claim timeout; minimum age for orphan deletion; push retry; honouring
  `notification_preferences`; a Hostinger cleanup entry point. All are documented in `docs/background-jobs.md` section 7.
* **P2-03** Kite Drive cleanup runs only when someone starts an upload; `api/_log/actions.log` is never rotated.
* **P2-04** Phase 5 business decisions still open (budget model, lead stage rules, retainer back-fill, employee expense claims, quotations, credit notes).
* **P2-05** Phase 6 leftovers: 8 redundant indexes, module lazy-loading and `chart.umd.js` not done; the documents attachments join still reads ~80k buffers at 20k rows.
* **P2-06** `employees.js` prints `employee_id` without escaping. The column is not user-writable (column-level grant), so this is not
  exploitable today; escape it when the file is next touched.
* **P2-07** Repository line endings: Git reports CRLF will be replaced by LF for files edited in this branch. Harmless, but the diff
  of a future merge may show whole-file noise if `.gitattributes` is not set.
* **P2-08** `docs/deployment.md` and `docs/security.md` still describe `EMP-001` as the format; updated for 038 only in `database.md`.
* **P2-09** Employee-ID: the first new ID after migration 038 may skip numbers (inserts that failed on the old default consumed
  sequence values). Cosmetic.

## 5. Migrations 001-038

### 5.1 Inventory, dependencies, re-run behaviour

"Re-run (LOCAL)" = an automated test applies the file a second time. "Header" = the file header says it is safe to run again;
not independently tested. "Not covered by a re-run test" = no automated second application of 001-019. 029-038 are re-applied by `verify-integrity` (section 0). 017/028/033/035 recovery is tested by
`verify-integrity` and by the P0-05 experiment.

| # | Purpose | Needs | Data / grants touched | Re-run | Rollback |
|---|---|---|---|---|---|
| 001 | Core schema, enums, sequences (incl. `employee_id_seq`) | numeric order (no prerequisite is stated in the header) | creates | Not covered by a re-run test | none |
| 002 | RLS policies, grants, `auth_*` helpers | numeric order (no prerequisite is stated in the header) | creates | Not covered by a re-run test | none |
| 003 | `updated_at` triggers | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 004 | Storage bucket `task-attachments` + policies | numeric order (no prerequisite is stated in the header) | inserts bucket row | Not covered by a re-run test | none |
| 005 | `push_subscriptions` | numeric order (no prerequisite is stated in the header) | creates | Not covered by a re-run test | none |
| 006 | Chat admin-post, realtime tables | numeric order (no prerequisite is stated in the header) | publication | Not covered by a re-run test | none |
| 007 | Assets, bucket `studio-assets`, realtime | numeric order (no prerequisite is stated in the header) | inserts bucket row | Not covered by a re-run test | none |
| 008 | Task links | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 009 | Content plans | 007 (stated in header) | - | Not covered by a re-run test | none |
| 010 | Client types / departments | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 011 | Visual layout | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 012 | Security hardening | numeric order (no prerequisite is stated in the header) | constraint validation | Not covered by a re-run test | none |
| 013 | Plan colours | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 014 | Broadcasts | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 015 | Owner-only money and client scope | numeric order (no prerequisite is stated in the header) | **moves money into `money_figures` (DML)** | Not covered by a re-run test | none |
| 016 | Chat v2, private channels, bucket `chat-media` | numeric order (no prerequisite is stated in the header) | DML, validation | Not covered by a re-run test | none |
| 017 | Finance and invoicing | numeric order (no prerequisite is stated in the header) | **legacy invoice load, DML** | **Hazard** (P0-05) | none |
| 018 | Typing indicator (Realtime policy) | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 019 | Kite Drive links | numeric order (no prerequisite is stated in the header) | - | Not covered by a re-run test | none |
| 020 | `replace_user_role()` | 002 | function | Header | text |
| 021 | `auth_is_owner()` privileges | 002 | grants | Header | text |
| 022 | Executive-only Finance | 015, 017, 021 | policies, `auth_is_finance()` | Header; **must precede 028/033/035/036/037 after a 017 re-run** | text |
| 023 | Last super-admin guard | 020 | triggers | Header | text |
| 024 | Finance-confidential assets | 007, 022 | column + backfill, asset policies | Header; **never re-run after 036 without re-applying 036** | text |
| 025 | Redact financial notifications | 022, owner approval | **rewrites notification rows** (backup in `finance_backup.notifications_pre025`) | One-time | text (restore from backup table) |
| 026 | Client asset scope, storage path binding | 007, 024 | triggers | Header | text |
| 027 | Plan-asset integrity guard | 026, 009, 012, 024 | validation | Header | text |
| 028 | Finance integrity (idempotency, locks, paid-sum) | 017 | request_id column, validation | LOCAL | text |
| 029 | History protection, tombstones, storage cleanup queue | 001-028 | **backfills audit actors**, delete guards, tables | LOCAL | text (see 5.3) |
| 030 | HR integrity | 001 | constraints, triggers | LOCAL | text |
| 031 | Approvals, expenses | 009, 017 | constraints, triggers | LOCAL | text |
| 032 | Atomic operations, dedupe keys, request ids, Drive-link intents | 014, 029 | **unique indexes** (can fail on duplicate data), columns | LOCAL | text |
| 033 | Database hygiene, studio date, append-only audit, FK indexes, `integrity_report()` | 028, 032 | validation, indexes | LOCAL; re-apply after 017/028 | text |
| 034 | Invitation activation, hashed tokens, expiry | 032 | column grants, `invitations.user_id` | LOCAL | text |
| 035 | Business correctness: `fin_kpis`, link guard, `lead_stage_history`, detectors | 033 | creates history table, 17-row report | LOCAL | text |
| 036 | Performance: 143 policy rewrites, 6 indexes, aggregates | 035 (generated from the post-035 chain) | policies | LOCAL | **`rollback-036.sql` (tested)** |
| 037 | Background jobs: ledger, digest batches, broadcast claim, requeue, detectors | 029, 032, 034, 035 | creates | LOCAL | **`rollback-037.sql` (tested)** |
| 038 | Employee-ID formatter and default | 001 | default, sequence moved forward only | LOCAL | **`rollback-038.sql` (tested; refuses past 999)** |

### 5.2 Ordering rules

1. Apply in numeric order, one file at a time, each as a single script (022, 023, 024, 025, 027 headers say so). Never `db push` on live.
2. 025 changes data: apply only after the owner approves.
3. 035's integrity report is rebuilt by 037; the final report has 19 rows.
4. 036 must come after 035 and before 037 only by convention (037 does not touch policies), but it **must be re-applied after anything that re-creates policies** (017, 022, 024).
5. 038 has no dependency except 001 and can be applied at any time after it; apply it **before the 1,000th employee** is created.
6. After a re-run of 017: **022 > 028 > 033 > 035 > 036 > 037** (verified, P0-05; 038 is unaffected). Do not re-run 024 afterwards without re-applying 036.
7. Stale text: the same wrong sequence (without 022) is also printed in comments inside the SQL files `033`, `035` and `037` and
   in the test notes. SQL was out of scope for the documentation pass, so those comments are still stale; this audit, the runbook,
   `docs/deployment.md`, `docs/database-integrity.md`, `docs/security.md`, `docs/performance-phase6.md` and `docs/background-jobs.md` are the authoritative text. Fix the SQL comments in a later change.

### 5.3 Rollback safety

| Migration | Rollback artefact | Safe after data exists? |
|---|---|---|
| 036 | `rollback-036.sql` | Yes: policies/indexes/functions only. **Roll the frontend back first** (the new SPA calls `task_stats`/`client_task_stats`). |
| 037 | `rollback-037.sql` | Drops `job_runs` and `storage_cleanup_requeues` **with their rows** (run history and requeue history are lost). Roll `due-reminders`/`broadcast` back first only if they would otherwise call the dropped functions (they would). |
| 038 | `rollback-038.sql` | **Refuses** once any ID above 999 exists or the sequence is past 998. Cannot be rolled back after the 1,000th employee. |
| 035 | header text | Dropping `lead_stage_history` **loses lead history**; the guards can be dropped without data loss. |
| 034 | header text | Hashed invitation tokens cannot be turned back into plain tokens (by design); the old accept flow still works for existing rows. |
| 033 | header text | Dropping the append-only trigger is possible; audit rows written meanwhile stay. |
| 032 | header text | Dropping the unique indexes loses the dedupe guarantee, not data. |
| 029 | header text | Dropping `storage_cleanup_queue` **forgets files waiting for removal** (they become orphans). Tombstones (`deleted_users`) are history: do not drop. |
| 025 | restore from `finance_backup.notifications_pre025` | Only for rows still unchanged. |
| 015, 017 | none | Data moves cannot be reversed; restore from backup. |
| 001-014, 016, 018, 019 | none | Restore from backup. |

## 6. Edge Functions

Inventory (12 functions + `_shared`). "Changed" = differs from the commit before Phase 3 (`22c31c0~1`). **None is verified in a real
Deno/Supabase runtime.**

| Function | Changed | Needs migrations | Secrets / env | JWT (`config.toml`) | Callers |
|---|---|---|---|---|---|
| `workflow` | yes | 020, 029, 031, 032 (the `storage.cleanup` guard is code-only; 037 is not required) | `ALLOWED_ORIGINS`; VAPID_* optional | true | SPA |
| `chat` | yes | 029, 032 | `ALLOWED_ORIGINS`; VAPID_* | true | SPA |
| `broadcast` | yes | **032, 037** | `ALLOWED_ORIGINS` | not declared (default true) | SPA (executives) |
| `due-reminders` | yes (rewritten) | **029, 032, 034, 037** | `CRON_SECRET`, `REMINDER_TZ`, `JOB_TIME_BUDGET_MS` (optional), VAPID_* | true | cron |
| `retainer-billing` | yes | 028, 033, (037 optional ledger) | `CRON_SECRET`, `REMINDER_TZ` | not declared (default true) | cron |
| `finance` | no (unchanged since Phase 3 base) | 017, 028, 033, 035 | `ALLOWED_ORIGINS` | not declared (default true) | SPA |
| `invite-employee` | yes | 029, 034 | `ALLOWED_ORIGINS`, `APP_URL` | true | SPA |
| `accept-invitation` | yes | **034** | `ALLOWED_ORIGINS` | true | invited user |
| `kite-drive` | yes | 019, 032 | `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL`, `ALLOWED_ORIGINS` | true | SPA |
| `client-preview` | yes | 031 | `ALLOWED_ORIGINS` | **false (public)** | share-link visitors |
| `content-plan` | no | 009 | `ALLOWED_ORIGINS` | true | SPA |
| `setup-admin` | no | - | `SETUP_TOKEN` | true | one-time bootstrap (**should not be deployed**) |

Deployment order inside the function layer (after the database): `accept-invitation`, `invite-employee`, `workflow`, `chat`,
`client-preview`, `content-plan`, `finance`, `broadcast`, `retainer-billing`, `due-reminders` last of this group (it sends notifications in
bulk: deploy it, then call it manually only on an isolated staging project). **`kite-drive` is deployed after the Hostinger PHP**, not with the
others (section 9, runbook D4 then D3b).

Compatibility: new `accept-invitation` needs 034 first; new `due-reminders` and `broadcast` need 037 first; the Phase 4 new
`kite-drive` issues tokens with a `jti` that an old PHP ignores. Old functions work against the new database (documented, untested).

Secrets (from the source): `ALLOWED_ORIGINS`, `APP_URL`, `CRON_SECRET` (>= 24 characters), `REMINDER_TZ` (default `Africa/Cairo`),
`JOB_TIME_BUDGET_MS` (new, optional, default 90000), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `KITE_DRIVE_API_SECRET`,
`KITE_DRIVE_URL`, `SETUP_TOKEN` (bootstrap only). `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` are platform-provided.

## 7. Security and operations review

LOCAL evidence only.
* **RLS and roles:** 203 + 1557 checks pass; 036 was proved equivalent to the pre-036 policies (SELECT on 63 tables x 18 principals,
  1,326 write outcomes) on a database with data. Finance is executive-only (022) and verified by the roles suite; P0-05 shows how it can
  regress on a 017 re-run.
* **Service role:** used only inside Edge Functions (`adminClient`), never in the frontend (the build refuses a `service_role` key).
  All new SQL functions of 035-038 are `service_role` only; the aggregates `task_stats`, `client_task_stats`, `fin_kpis`,
  `fin_client_balances` are SECURITY INVOKER (RLS decides).
* **Storage:** buckets are private; path binding and finance-confidential scope are in 026/024. Storage policies were tested against a
  stub `storage.objects` table, **not against the real Storage service**.
* **Secrets:** none in the repository (the build fails otherwise). `api/config.php` on Hostinger is outside the repository.
* **Public surface:** `client-preview` (`verify_jwt = false`) and the Drive file endpoints. Token checks are tested locally only.
* **Backups/PITR:** needed before release (P0-04). PITR requires the paid Supabase add-on; whether it is enabled is unknown.
  Restore testing is a prerequisite, not a nicety, because 015/017/025/029 move or rewrite data.
* **Monitoring:** `integrity_report()` (19 rows), `job_status()`, `storage_cleanup_status()`, Edge Function logs, audit log. No
  alert is configured (`docs/production-checklist.md` section 6 lists the items as unchecked). Phase 7 deliberately sends no alerts.
* **Failure recovery procedures:** documented in `docs/background-jobs.md` (re-run a job; requeue exhausted storage files; resume a
  broadcast with the same request id). Not exercised on staging.

## 8. Cron and background jobs

Implemented, **not verified remotely**. Created by hand in Dashboard -> Integrations -> Cron -> HTTP request.

| Job | Endpoint | Schedule (suggested; owner confirms) | Frequency | Depends on | Failure recovery |
|---|---|---|---|---|---|
| `retainer-billing` | `POST /functions/v1/retainer-billing` | daily 06:00 Africa/Cairo | daily | 028, 033, `CRON_SECRET`; creates monthly drafts, marks overdue | Re-run manually (idempotent per plan and month; the alert has a monthly key). `SELECT * FROM fin_retainer_gaps(); SELECT * FROM fin_retainer_drafts_unreviewed();` |
| `due-reminders` | `POST /functions/v1/due-reminders` | daily 07:00 Africa/Cairo (after retainer-billing) | daily | 029, 032, 034, 037, `CRON_SECRET`, `REMINDER_TZ` | Re-run manually; a `partial` run is resumed by running again; inspect `job_runs` |
| Kite Drive cleanup | none (runs on upload start) | - | on demand | - | No scheduled job exists to configure; decision pending (P2-03) |

Headers for both: `Authorization: Bearer <anon key>` and `x-cron-secret: <CRON_SECRET>`.
Verification queries: `docs/background-jobs.md` section 3 (`job_status()`, `job_missed_runs(interval, expected jobs)`, `job_stuck_runs(interval)`,
`cron.job` / `cron.job_run_details` if pg_cron is used).

## 9. PHP / Kite Drive (Hostinger)

**Files.** Runtime files changed in this branch (all in Phase 4, commit `bca603e`): `integrations/kite-drive/api/index.php`, `api/lib.php` (new;
`index.php` requires it) and `api/send.php`: upload the three together. `api/config.sample.php` also appears in the diff but is **not a
runtime file and is never uploaded as `config.php`**: it is the template for a new installation. The live `api/config.php` holds the shared secret
and the database credentials, is not in the repository, and must not be replaced (that would lock Drive out or break its database connection).
The sample changed by one addition, the option `'url_tokens' => 'legacy'`; add that one line to the **live** `config.php` by hand (the code defaults to `legacy`
when the key is missing, so this only makes the later switch explicit). `tests/lib_test.php` is not uploaded.

**Order (resolves the apparent ambiguity between the function and the PHP).**
1. The `kite-drive` Edge Function can be **deployed** any time after migration 032 (publishing it calls nothing).
2. It can be **invoked safely** only after the new PHP is on Hostinger and the two sides share the secret (`KITE_DRIVE_API_SECRET` equals `config.php`'s secret;
   `KITE_DRIVE_URL` is the Drive site). Invoked against the old PHP it works (the old PHP ignores the new `jti` and `fid` claims, as documented in
   `docs/phase4-release.md`; not re-tested here) but the new protections are inactive: address-carried download/ZIP tokens are not single-use, view tokens are not
   locked to one file, and the per-e-mail lock when creating a Drive account is missing.
3. The new PHP is backward compatible: with `url_tokens = 'legacy'` it accepts tokens with or without `jti` and both token transports, so the old function and the old web app keep working.
4. Therefore: **PHP first (runbook D4), then the `kite-drive` function (D3b), then the web app (D6)**. This differs from the order printed in
   `docs/phase4-release.md` (functions, then PHP, then web app); both are workable, PHP-first never leaves a weaker window and is the one used here.
5. `url_tokens = 'strict'` is a later, separate change after the new web app has been live and cached copies are gone; roll back by setting it to `legacy`.

**Unverified:** real MySQL, `memory_limit`/`max_execution_time`, GD thumbnail limits on Hostinger, the stale-upload cleanup schedule, the new function against the
old PHP, and whether the earlier PHP (before `bca603e`) is what is currently deployed. **Rollback:** the previous PHP copies and, only if it was edited, the saved
`config.php` (the `drive_token_uses` table can stay); roll `kite-drive` back before the PHP.

## 10. Frontend

* Build: `npm run build` (Vercel), needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables; the service worker cache id is
  generated per build (`sw.js` placeholders), so a new deployment replaces cached copies on the next visit.
* Database dependencies: the new web app needs 032 (`create_entity_with_figure`, `update_entity_with_figure`, `set_client_departments`),
  035 (`fin_kpis`, `fin_client_balances`), 036 (`task_stats`, `client_task_stats`). It also expects `lead_stage_history` (035) and the
  Phase 4 Edge Functions. **Deploy the web app last.**
* The old web app works with the new database (documented; `verify-requests` can run against an old checkout via `FRONTEND_DIR`), so
  rolling the web app back is safe at any time.
* Gaps: no real-browser test; CSP and service-worker behaviour untested with the new build; mobile layouts and Realtime under real
  network not verified.

## 11. What could not be verified (summary)

Live schema/function/PHP versions; live policy text; live data validity for the new constraints and unique indexes; table sizes (index
build locks); the platform Edge Function time limit; Edge Functions in Deno; Supabase Auth, Storage and Realtime behaviour; cron
configuration and secrets; PITR/backup state and restore; Vercel branch/auto-deploy settings; Hostinger PHP/MySQL behaviour and which
PHP version is deployed; real-browser behaviour; managed-Postgres absolute performance.

## 12. Sign-off table (to be filled during the rehearsal and release)

| Gate | LOCAL | STAGING | PRODUCTION |
|---|---|---|---|
| Migrations 001-038 apply in order | yes | **no** | **no** |
| 029-038 re-run safe | yes | no | no |
| Recovery after 017 re-run (022 > 028 > 033 > 035 > 036 > 037) | yes (experiment) | no | no |
| Rollbacks 036 / 037 / 038 | yes | no | no |
| RLS equivalence (036) | yes | no | no |
| Edge Functions | syntax + source rules | **no** | **no** |
| Cron jobs | n/a | **no** | **no** |
| PHP / Kite Drive | `php -S` | **no** | **no** |
| Frontend | fake DOM | **no** | **no** |
| Backup restore | n/a | **no** | **no** |
