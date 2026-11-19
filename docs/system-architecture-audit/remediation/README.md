# Remediation package — Kite System issue register

Date: 2026-11-06 · Repo `main` @ `5e951e1` · **No application file, schema, setting or deployment was changed.**

| File | Content |
|---|---|
| `MASTER_ISSUE_REGISTER.md` / `.csv` | 37 issues with all required fields; canonical IDs |
| `SECURITY_ISSUES.md`, `FUNCTIONAL_ISSUES.md`, `DATABASE_ISSUES.md`, `ARCHITECTURE_ISSUES.md`, `PERFORMANCE_ISSUES.md`, `OPERATIONS_ISSUES.md`, `TESTING_ISSUES.md` | the same issues by category |
| `REMEDIATION_ROADMAP.md` | P0-P3 plan; 15 fix packages (FX-01..FX-15) with changes, migration risk, rollback, acceptance |
| `REMEDIATION_DEPENDENCY_GRAPH.mmd` | what must be fixed first; shapes show migration / external config |
| `VERIFICATION_PLAN.md` | read-only SQL/CLI/curl checks and staging tests (none could be run live) |
| `UNVERIFIED_RISKS.md` | what remains unknown and what was not read |
| `issues_data.py`, `build_register.py` | single data source and generator; the generator fails if an issue cites a graph node, table or workflow that does not exist |

## Notion publication (verified 2026-11-06 by fetch/query)
Under Kite System / Technical Audit / Issue Register and Remediation: Master Issue Register database (37 rows; severity counts re-queried and match: HIGH 1, MEDIUM 15, LOW 20, INFORMATIONAL 1), Remediation Roadmap, Fix Dependency Graph (Mermaid), Issues by Category, Verification Plan and Unverified Risks. Issues are related to Components, Tables and Workflows; DAT-02, DOC-01, DOC-02, DAT-03 have no component relation by design. Category files are one index page plus the database's Category property, not seven separate pages. No Notion update was made to the application or its data.

## Phase 0 verification status (2026-11-07)
IDs and classifications unchanged. See `../phase-0/`. ARC-01 live status: NOT VERIFIED — LIVE ACCESS REQUIRED (`ceo` is never created by the seed/migrations, only referenced). OPS-04: NOT ACCESSIBLE, restore not verified. OPS-01: both jobs dashboard-only, live NOT ACCESSIBLE (`retainer-billing` missing from the production checklist). OPS-02: re-run 153 passed / 0 failed; all 19 migrations build cleanly in PGlite with stubs; no CI. Docs recommend `supabase db push`, contrary to the live-project rule (RISK-05).

## ARC-01 remediation status (2026-11-07)
Source fix implemented and tested locally on branch `fix/arc-01-role-tiers` (migrations 020-025 — 022 makes Finance executive-only, 023 guards the last super_admin, 024 protects contracts, 025 redacts old notifications, see `../phase-0/FINANCE_ACCESS_AUDIT.md`; shared tier model in `_shared/auth.ts`, `supabase/tests/verify-roles.mjs`). **Not deployed; production not verified.** Severity (HIGH) and priority (P1) are unchanged. See `../phase-0/ARC-01_AUTHORIZATION_INVESTIGATION.md` and `../phase-0/ARC-01_LIVE_ROLE_VERIFICATION.md`.

## Executive report
1. **Total issues:** 37 (14 preserved from the previous audit with unchanged IDs, 23 new). Duplicate symptoms were grouped (for example role-list drift, tier escalation and expense-approval mismatch are all ARC-01).
2. **Confirmed:** 23 · 3. **Strong Evidence:** 4 · **Potential:** 7 · 4. **Unverified:** 3.
5. **CRITICAL:** 0 · 6. **HIGH:** 1 (ARC-01) · 7. **MEDIUM:** 15 · 8. **LOW:** 20 · INFORMATIONAL: 1.
Priorities: P0 0 (one conditional, see roadmap) · P1 5 · P2 13 · P3 19.
9. **Ten most important:** ARC-01 (role model; role tiers not enforced consistently: general_manager over owner/super_admin, HR over ceo/finance roles), OPS-02 (tests validate a different schema; no CI), OPS-01 (dashboard-only crons), OPS-04 (no evidence of backups/monitoring), SEC-01 (public share endpoint), DAT-06 (currency model), DAT-04 (browser-insert validation gaps), DAT-05 (non-atomic role changes), FUN-02 (UTC vs Cairo in finance), SEC-06 (asset path confused deputy).
10. **Fix first:** verify whether the `ceo` role exists live; if so apply the ARC-01 interim patch immediately. Then FX-02 (CI + full matrix), FX-03, FX-04 in parallel.
11. **Parallel:** FX-02, FX-03, FX-04, FX-09 start together; after FX-02: FX-01, FX-07, FX-08, FX-10, FX-15.
12. **Could break during remediation:** capability mapping (FX-01), constraint validation on legacy rows (FX-07), Hostinger/Edge version skew (FX-05), duplicate schedules (FX-03), push delivery during the outbox change (FX-11), cleanup jobs (FX-12).
13. **Blocks production readiness:** unverified backups/restore and monitoring (OPS-04), unmonitored crons (OPS-01), the incomplete security test net (OPS-02), and the role-model gap (ARC-01) pending live verification.
14. **Unverified:** live RLS/grants, cron, secrets, time zone, data quality, performance and Hostinger state (see `UNVERIFIED_RISKS.md`), and everything that depends on the empty Notion specification.

## What was added to the evidence this pass
Read in full for the first time: `invite-employee`, `content-plan`, `broadcast`, `_shared/push.ts`, `_shared/validate.ts`, `chat` and `workflow` (all), `due-reminders` (rest), finance SQL functions and constraints, the assets/storage/chat-media/realtime policies, router, auth modules, preview page, realtime and notification services, escaping helpers. Executed: the RLS suite. Findings that changed: ARC-01 raised to HIGH; OPS-02 refined with observed results; SEC-05 downgraded to Potential after reading the escaping code.
