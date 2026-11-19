# Phase 0 Executive Report — Safety and Production Baseline
Date: 2026-11-07 · Repo `main` @ `5e951e1` · Read-only. No application code, schema, setting, role, job or deployment was changed.

## Executive summary
Everything that can be established from the repository and this machine is documented. Everything that depends on live Supabase, Vercel, Hostinger or GitHub settings is **NOT ACCESSIBLE** from this session and is reported as such, with ready-to-run read-only checks. Phase 0 is therefore complete on the repository side and **blocked on live verification**.

## Verified facts (REPO/LOCAL)
- Clean git tree for tracked files; 4 untracked paths preserved; no CI workflows exist.
- RLS suite re-run: **153 passed, 0 failed** (covers migrations 001-005, 016, 017 only).
- All 19 migrations apply in order to an in-memory Postgres with stubs: 68 tables, 0 without RLS, 175 policies, 141 FKs, 0 SECURITY DEFINER functions without a pinned search_path, 0 `anon` grants.
- The `ceo` role is never created by the seed or migrations; it appears only in role lists in code.
- Both scheduled jobs are dashboard-configured and unversioned; `retainer-billing` is missing from the production checklist.
- Docs recommend `supabase db push`, which conflicts with the rule for the live project.
- No staging environment, backup/restore record, runbook or tests for Edge Functions, PHP or UI exist in the repo.

## Unverified facts
Live RLS/grants/policy drift, `ceo` existence and holders, backups and restore, cron state, secrets/function list (including `setup-admin`), DB time zone, data quality, Hostinger state, branch protection, performance numbers.

## Critical blockers
RISK-01 (ARC-01 live status), RISK-02 (backup/restore), RISK-09 (live policy drift), RISK-04 (no CI). Full list: `RISK_AND_BLOCKER_REGISTER.md`.

## Results by area
| Area | Result |
|---|---|
| ARC-01 | `NOT VERIFIED — LIVE ACCESS REQUIRED`; queries in `ARC-01_LIVE_ROLE_VERIFICATION.md` |
| Backup / restore | NOT ACCESSIBLE / restore NOT VERIFIED |
| Scheduler | repo: 2 dashboard-only jobs, no alerts; live NOT ACCESSIBLE |
| Testing / CI | suite 153/0 but partial; no CI; unsafe change can merge |
| Deployment risks | manual, uncoordinated PHP/Edge/SPA/DB releases; DB forward-only; no staging |
| Performance | static counts only (~241 `.from`, ~2 `.rpc`, ~11 `.channel`); no runtime numbers |

## Recommended next actions
1. Owner (or someone with access) runs the ARC-01 queries and returns counts.
2. Record backup settings and perform one restore into a scratch project.
3. Read the cron list and last runs; confirm `setup-admin` is not deployed.
4. Run the live policy/grant/trigger counts (A1, A2, A5-A7) to detect drift.
5. Correct the `db push` guidance and decide on a staging project.

## Is Phase 1 safe to start?
**Not yet.** Safe only after items 1 and 2 above, or an explicit written acceptance of that risk. Phase 1 has not been started; waiting for your approval.

## Phase 0 deliverables
This folder: GIT_AND_RELEASE_BASELINE, ENVIRONMENT_INVENTORY, ARC-01_LIVE_ROLE_VERIFICATION, BACKUP_RESTORE_VERIFICATION, SCHEDULER_BASELINE, TESTING_CI_BASELINE, DATABASE_SAFETY_BASELINE, DEPLOYMENT_DEPENDENCY_MATRIX, PERFORMANCE_BASELINE, RISK_AND_BLOCKER_REGISTER, PHASE_0_EXIT_CHECKLIST.
