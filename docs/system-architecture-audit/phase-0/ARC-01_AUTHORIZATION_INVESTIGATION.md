# ARC-01 Authorization Investigation (read-only)
Date: 2026-11-07 · Repo `main` @ `5e951e1`. Nothing was modified. Evidence classes: **SRC** = source read; **PROD-REPORTED** = facts you supplied from production (not re-observed by me); **NOT VERIFIED**. Production security is **not** claimed verified by this report.

## 0. Correction to earlier work
Earlier ARC-01 wording ("HR can grant or disable owner-tier roles", "no owner-tier guard") was **too broad**. Source shows HR **is blocked** from granting, modifying or deleting `super_admin`, `owner` and `general_manager` holders. The real gaps are different (section 4). `ARC-01_LIVE_ROLE_VERIFICATION.md` has been corrected and the register's ARC-01 text should be re-worded after your approval; no classification was changed.

## 1. Role-mutation entry points (complete inventory)
Only the **service role** can write `roles`/`user_roles`: PROD-REPORTED `authenticated` has SELECT only (matches `002_rls_policies.sql` L228, L240, and L258 `GRANT ALL ... TO service_role`). I found **no SQL function, trigger or RPC that writes `user_roles`** (grep of all migrations: the only writes are `INSERT INTO roles` in `seed.sql` L16 and `017` L19). The PHP API and `kite-drive` function contain no role writes.

| # | Entry point | File:line | Operation | Caller auth |
|---|---|---|---|---|
| E1 | `invite-employee` (invite / re-invite) | `invite-employee/index.ts` L112 | INSERT `user_roles` for a new user | `getCaller` (JWT via `admin.auth.getUser`, `_shared/auth.ts` L44-52) then admin or `hr_manager` (L19) |
| E2 | `invite-employee` action `delete` | L26-43 | deletes auth user, cascades to roles | same gate; target guard L33-34 |
| E3 | `workflow` action `employee.update` | `workflow/index.ts` L416-525; role write L502-503; status ban L508 | DELETE then INSERT `user_roles`; status change | admin or `hr_manager` (L417); target guard L429-431 |
| E4 | `setup-admin` | `setup-admin/index.ts` L69 | INSERT first `super_admin` | `SETUP_TOKEN` header + DB lock + refuses if a super_admin exists |
| E5 | `accept-invitation` | `accept-invitation/index.ts` L29-31 | only `employment_status` onboarding→active; **no role write** | `getCaller`, status must be `onboarding` |
| E6 | Direct PostgREST by browser | n/a | blocked by grants (SELECT only); `profiles` UPDATE limited to 8 self columns (002 L249-252), role/status not included | RLS + column grants |
| E7 | SQL editor / service key / seeds | `seed.sql`, manual | unrestricted, **no audit** | operator |

Related service_role uses (`adminClient()` in every function) all call `getCaller` first; role *reads* for authorization are in `_shared/auth.ts` L55-62. Invitation `role_id` stored in `invitations` is never consulted at acceptance (role fixed at invite), so invitation acceptance cannot change a role.

## 2. Authorization decision flow
```
request -> Bearer JWT -> admin.auth.getUser (401 if bad)
        -> load profile.status + active roles (service role)      [auth.ts L55-62]
        -> isAdmin = active AND any of {super_admin, owner, general_manager}  [auth.ts L5, L79]
        -> gate: isAdmin OR has('hr_manager')                      [invite L19, workflow L417]
        -> target guard: target holds admin-level role AND caller !isAdmin -> 403   [invite L33-34, workflow L429]
        -> role guard: requested role in admin-level AND caller !isAdmin -> 403     [invite L59, workflow L469]
        -> super_admin granted only by super_admin                                  [invite L62, workflow L470]
        -> self role change refused (workflow L466); last super_admin kept on role change only (L472-475)
        -> write via service role, audit EMPLOYEE_INVITED/UPDATED/DELETED
```
SQL side: `auth_is_admin()` = super_admin/owner/general_manager (`002` L71-81); `auth_is_owner()` = super_admin/owner/**ceo** (`015` L15-25). Two different sets drive "admin" vs "money owner".

## 3. Answers to the questions
| Question | Answer | Basis |
|---|---|---|
| Can HR grant `super_admin`, `owner`, `general_manager`? | **No** (403) | SRC invite L59-63, workflow L469-470 |
| Can HR modify, disable or delete holders of those roles? | **No** | SRC invite L33-34, workflow L429-431 |
| Can HR grant/modify `ceo`? | **Yes, if a `ceo` role row exists** (`ceo` is not in the admin-level lists) | SRC; role existence NOT VERIFIED |
| Can HR grant `finance_manager`/`accountant` (money powers: `finance/index.ts` L23-24, `auth_is_finance` 017 L23-30)? | **Yes** by design of the lists | SRC |
| Does HR exist in production? | **No users hold `hr_manager`** | PROD-REPORTED: currently not exploitable by HR |
| Can an employee escalate? | No path found: no role-write grant, no role-writing RPC, profile role/status columns not updatable | SRC + PROD-REPORTED grants |

## 4. Confirmed vulnerabilities (SRC; exploitability depends on live state)
**V1 — `general_manager` can escalate to owner tier and neutralise owners/super admin** (ARC-01 core, severity **HIGH** if the GM account is malicious or compromised; MEDIUM otherwise). Conditions: attacker holds `general_manager` (PROD-REPORTED: one user does).
- *Grant owner:* the role guard blocks only non-admins, so `isAdmin` (includes GM) may grant `owner`: `invite-employee` L59 and `workflow` L469. Only `super_admin` needs a super_admin (L62/L470). A GM can invite a new account (an email they control) with role `owner`, or promote another account they control, gaining `auth_is_owner()`: budgets, vendors, invoices, expenses, finance settings (015 policies). Self-promotion is blocked (workflow L466) but a second account bypasses it.
- *Disable/delete top tier:* `employee.update` with `employmentStatus: inactive` bans the target (L508) and `delete` removes the account; the target guard (L429, invite L33) only requires `isAdmin`, so a GM can disable or delete **both owners and the super_admin**. The "last super admin" check (L472-475) runs only on **role changes**, not on status change or delete, so the only super_admin can be disabled or deleted by a GM.
- Mitigation present: every action is audited (below) and self-delete/self-deactivate are refused.

**V2 — Role-set inconsistency around `ceo`** (MEDIUM, latent). `ceo` is in `auth_is_owner`, the frontend (`permission-service.js` L72, `money.js` L10, `broadcast.js` L14), `broadcast`, `finance`, `kite-drive` L54-55, but not in `ADMIN_ROLES`/`ADMIN_LEVEL`. If a `ceo` row exists, a ceo holder has owner money access but cannot manage employees, and HR can grant and modify `ceo`. The repo never creates `ceo` (seed L16-27).

**V3 — Non-atomic role replace** (DAT-05, MEDIUM): `workflow` L502-503 deletes then inserts; a failure between leaves the user with no role (not an escalation).

**V4 — Re-invite reset** (LOW): `invite-employee` L68-74 deletes an `onboarding` user and recreates it with the **requested** role; the existing target's role is not checked, so HR can delete an onboarding admin-level invitee and re-invite as a lower role (denial of an invitation, no escalation).

## 5. `auth_is_owner()` and PUBLIC EXECUTE
- Source: `015` creates it with no REVOKE/GRANT (L15-25); `017` explicitly does `REVOKE ALL ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated, service_role` for `auth_is_finance` (L34-35). `002` L28-33 revokes functions from PUBLIC/anon/authenticated and sets default privileges, which evidently did not apply to the function as it exists in production (PROD-REPORTED PUBLIC EXECUTE): a **drift/inconsistency signal**, to be checked for the other helpers.
- Impact today: low. It is `SECURITY DEFINER`, `search_path=''`, and depends only on `auth.uid()`; for `anon` it returns false (`auth_is_active()` is false with no uid), for others it reveals only the caller's own owner status. It does enlarge the exposed RPC surface (`/rest/v1/rpc/auth_is_owner` for anon).
- Does restricting break anything? All policies using it are `TO authenticated` (015 L73-120, 017); `anon` has no table grants, so it never evaluates policies; Edge Functions use the service role. Required grants after restriction: `authenticated`, `service_role` (and the owner role keeps implicit rights). **Recommended:** `REVOKE EXECUTE ON FUNCTION public.auth_is_owner() FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated, service_role;`. Before applying, confirm with `pg_policies` that no policy targets `anon`/`public` using it. Hygiene fix, severity LOW; not an escalation by itself.

## 6. Frontend vs backend mismatch
- `employees.js` L26 and L194 show edit/delete/invite controls to `isAdmin || hr_manager`, and L273 offers **every** role in the dropdown. Backend rejects admin-level grants for HR with a 403 (a UX inconsistency, not a hole). The frontend treats `ceo` as owner-tier (`permission-service.js` L72); the backend does not treat it as admin. The frontend's admin set is unverified by me beyond `Permissions.isAdmin()` usage; frontend checks are not a security boundary and the backend recheck exists (`getCaller`).

## 7. Audit trail
Role and status changes are logged by the functions: `EMPLOYEE_INVITED` (newData.role), `EMPLOYEE_UPDATED` (oldData.roles, newData.role), `EMPLOYEE_DELETED` on entity `profiles` (invite L132, workflow L516-521, invite L42). A search for "role" in action names would miss them. Gaps: audit insert failures are swallowed (`auth.ts` audit()), and E7 (SQL editor/service key) leaves no trail. Absence of events is PROD-REPORTED only for the initial search.

## 8. Canonical policy and smallest safe fix (not implemented; awaiting approval)
Canonical tiers (proposal): **Tier 0** super_admin; **Tier 1** owner and ceo (alias, treat as one); **Tier 2** general_manager; finance roles are Tier 3 assignable only by Tier 1+. Rule: *a caller may grant, modify, disable or delete only accounts whose highest tier is strictly below the caller's own, and may grant only roles strictly below their own; super_admin assigns Tier 1; Tier 1 assigns Tier 2 and below; HR assigns only non-privileged operational roles.* Never remove/disable/delete the last active super_admin on any path.

Smallest safe change (code-only, no migration), in `invite-employee` and `workflow`: (1) one shared `ROLE_TIER` map and `canManage(caller, targetRoles)`/`canGrant(caller, role)` in `_shared/auth.ts`; (2) GM may not grant, modify, disable or delete owner/ceo/super_admin; (3) HR may not grant or modify `ceo`, `finance_manager`, `accountant`; (4) last-super-admin check extended to status change and delete; (5) make the role replace atomic (single RPC or transaction; DAT-05). Plus the `auth_is_owner` privilege hygiene SQL above (separate, trivial migration). A one-line interim for V1 only: remove `owner` from what a GM can grant/touch (require `caller.has('super_admin') || caller.has('owner')` for those targets).

## 9. Regression tests (to add; none exist for the functions)
Role matrix over `invite-employee` (grant) and `workflow employee.update` (role, status, department) and `delete` for callers {super_admin, owner, ceo, general_manager, hr_manager, finance_manager, employee, client, suspended} x targets {each role}; expectations from the policy above. Specific cases: GM grants owner → 403; GM disables/deletes owner or super_admin → 403; last super_admin status change/delete → 409; HR grants ceo/finance_manager → 403; self role change → 400; role-replace failure injection leaves the previous role; invitation acceptance never changes roles; direct PostgREST insert/update/delete on `user_roles`/`roles` as authenticated → denied; `anon` EXECUTE on `auth_is_owner` → denied after the fix; `pg_policies` has no anon/public policy using it. Extend the RLS suite to the full migration chain (OPS-02).

## 10. Production verification checklist (read-only)
1. `SELECT name, is_active FROM roles;` — does `ceo` exist? Does `accountant`?
2. `SELECT r.name, count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id GROUP BY 1;` (counts only; matches your report, add ceo/finance/accountant).
3. `SELECT r.name, count(*) FILTER (WHERE ur.assigned_by IS NULL) AS no_assigner FROM user_roles ur JOIN roles r ON r.id=ur.role_id GROUP BY 1;` and, for each privileged row, `assigned_by`'s role (counts only).
4. Audit: `SELECT action, count(*), max(created_at) FROM audit_logs WHERE action IN ('EMPLOYEE_INVITED','EMPLOYEE_UPDATED','EMPLOYEE_DELETED') GROUP BY 1;` and `... WHERE new_data ? 'role'` filtered to owner/super_admin/ceo.
5. Privileges: `SELECT proname, proacl FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'auth\_%';` (a `=X/...` entry means PUBLIC EXECUTE), and `has_function_privilege('anon', oid, 'EXECUTE')` per helper; compare all helpers with `auth_is_finance`.
6. `SELECT polname, polroles::regrole[] FROM pg_policy WHERE pg_get_expr(polqual,polrelid) ILIKE '%auth_is_owner%' OR pg_get_expr(polwithcheck,polrelid) ILIKE '%auth_is_owner%';` — roles must be authenticated only.
7. `has_table_privilege('authenticated','public.user_roles','INSERT,UPDATE,DELETE')` and the same for `roles` and `profiles(employment_status)` column privileges: all false.
8. Confirm deployed function versions match this commit (`supabase functions list`) and that `setup-admin` is not deployed.
9. Review Auth settings: sign-ups disabled.
Record date, operator and result; do not paste emails or keys.
