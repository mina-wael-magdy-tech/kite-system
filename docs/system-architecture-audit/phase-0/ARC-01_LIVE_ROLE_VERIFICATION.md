# ARC-01 — Live Role Security Verification

## RESULT: `NOT VERIFIED — LIVE ACCESS REQUIRED`
No production database, Supabase dashboard/CLI or SQL access exists in this session. Nothing below infers live state from migrations.

## What the repository shows (REPO evidence, not live)
- The `roles` seed (`supabase/seed.sql` L16-27) defines 10 roles: super_admin, owner ("Owner / CEO"), general_manager, department_manager, team_leader, employee, project_manager, hr_manager, finance_manager, client. **There is no `ceo` row.** Migration 017 adds `accountant`.
- `'ceo'` appears only as a string inside role lists (015 L22, 017 L30, and 3 occurrences in functions/js). The repo never creates it, so `ceo` can exist live only if someone created it by hand. Whether it does: **NOT VERIFIED**.
- **Correction (2026-11-07):** this file originally said `invite-employee`/`workflow` have no owner-tier guard for HR. That was too broad. HR is blocked from granting or modifying `super_admin`/`owner`/`general_manager`; the actual gaps are `ceo`/finance roles for HR and `general_manager` over `owner`/`super_admin`. See `ARC-01_AUTHORIZATION_INVESTIGATION.md`. Production was reported to have no `hr_manager` holders.

## Remediation status (2026-11-07)
Source-confirmed findings (from reading the code) are separate from production-verified facts. **Production-verified by this audit: none.** Production facts below were *reported to the audit* (not re-observed): roles/user_roles have RLS and `authenticated` has SELECT only; no user holds `hr_manager`; two hold `owner`, one `super_admin`, one `general_manager`; `auth_is_owner()` has PUBLIC EXECUTE. A source fix (branch `fix/arc-01-role-tiers`, migrations 020/021/022, including the approved executive-only Finance policy: super_admin, owner and ceo are one tier) is implemented and passes local tests but is **not deployed**. Whether a `ceo` role exists in production is **still not established** and must be verified before and after deployment.

## The six questions
| # | Question | Answer | Basis |
|---|---|---|---|
| 1 | Can HR grant `ceo`? | Code does not block it **if the role exists**. Live: NOT VERIFIED | REPO |
| 2 | Can HR grant super_admin/owner/general_manager? | **No** (403, source-confirmed). HR can grant `ceo` (if it exists) and finance roles | REPO |
| 3 | Can HR disable/remove holders of those roles? | **No** for super_admin/owner/general_manager holders; yes for a `ceo`-only holder. The real escalation is general_manager over owner/super_admin (investigation V1) | REPO |
| 4 | Can a normal employee escalate? | No path found in source. The local RLS suite (153/0) covers self-role-write denial, but only on migrations 001-005/016/017. Live: NOT VERIFIED | REPO + LOCAL |
| 5 | Are role checks consistent across SQL, functions and frontend? | **No**: the lists differ by location (the ARC-01 root cause) | REPO |
| 6 | Is `ceo` active in production? | `NOT VERIFIED — LIVE ACCESS REQUIRED` | none |

## Manual verification (read-only; run by someone with SQL access; return counts only, no names or emails)
```sql
SELECT name, is_active FROM roles
 WHERE name IN ('ceo','owner','super_admin','general_manager','finance_manager','accountant','hr_manager');

SELECT r.name, count(*) AS holders,
       count(*) FILTER (WHERE ur.assigned_by IS NULL) AS no_assigner,
       count(*) FILTER (WHERE ur.assigned_by IN (
         SELECT x.user_id FROM user_roles x JOIN roles rr ON rr.id = x.role_id WHERE rr.name = 'hr_manager')) AS assigned_by_hr
  FROM user_roles ur JOIN roles r ON r.id = ur.role_id
 WHERE r.name IN ('super_admin','owner','ceo','general_manager','finance_manager','accountant','hr_manager')
 GROUP BY r.name;
```
Decision rule: if `ceo` exists, or `assigned_by_hr` > 0 for an owner-tier role, apply the interim ARC-01 patch (code-only, `invite-employee` + `workflow`) first. Otherwise ARC-01 stays HIGH as a code-hardening item.
