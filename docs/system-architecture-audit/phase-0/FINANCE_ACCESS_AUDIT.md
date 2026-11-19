# Finance access audit and executive-only enforcement
Date: 2026-11-07 · Branch `fix/arc-01-role-tiers` · Evidence: **source read + local tests**. Nothing was run against production; production state is **not verified**.

Approved policy: super_admin, owner and ceo are one equal executive tier and are the **only** roles that may view Finance data anywhere. finance_manager and accountant get no Finance read access, and belonging to the Finance department grants none. They may be granted by executives only.

## 1. Finance data inventory (what exists in the schema)
| Data | Where | Notes |
|---|---|---|
| Invoices, lines, payments, retainers, client billing, settings, numbering, finance audit | `invoices`, `invoice_items`, `invoice_payments`, `retainer_plans`, `client_billing`, `finance_settings`, `invoice_number_seq`, `finance_audit_log` (017) | |
| Expense claims and approvals | `expenses`, `expense_approvals` | |
| Budgets, vendors | `budgets`, `vendors` | |
| Client monthly fees, project/campaign/department budgets, lead/deal values | `money_figures` (015); the old columns are blanked by the `blank_money` trigger | |
| Salaries, compensation, payroll | **no table or column exists** (payroll is "later" in `docs/finance.md`) | gap G1 |
| Contracts | none as data; `employee_documents` is a generic HR file table with free-text `document_type` and no UI | gap G1 |
| Pre-017 copies | schema `finance_backup` (`*_pre017`) | unreachable through the API |

## 2. Every read path inspected
| Path | Finding before | Now |
|---|---|---|
| RLS on the 13 tables above | **Leak (source-confirmed):** 015 made money owner-only, then 017 widened SELECT to `auth_is_finance()` = executives + finance_manager + accountant on all finance tables, plus `invoices_select`, `expenses_select_finance`, `budgets_select_finance`, `vendors_select_finance`. `expenses_select` also let a submitter and `expense_approvals_select` let admins/finance_manager/submitter read | migration 022: `auth_is_finance()` = executive only; `expenses_select` and `expense_approvals_select` executive only |
| `clients` | 017 `clients_select_finance` let finance roles read **every** client | dropped; finance roles revert to department-scoped client visibility |
| `audit_logs` | readable by every admin (incl. general_manager); contains `EXPENSE_*` events | finance events (EXPENSE_* and finance entity types) executive-only; other events unchanged |
| SQL functions / RPC | all data-changing `fin_*` functions are granted to `service_role` only (017 L732); `fin_round`/`fin_calc_line` (arithmetic) and trigger functions are executable by PUBLIC but return no data | verified by test; no change |
| Edge `finance` | gate = executives + finance_manager + accountant; "senior" actions included finance_manager | executives only (`isExecutive`) |
| Edge `workflow` `expense.decide` | admins (incl. general_manager) and finance_manager | executives only |
| Edge `workflow` `expense.submitted` | notified admins, finance_manager, accountant **with the amount** (`EGP 500`) | executives only |
| Edge `retainer-billing` (cron) | notified finance_manager, accountant, owner, super_admin | executives incl. ceo |
| Edge `client-preview`, `content-plan`, `due-reminders`, `broadcast`, `kite-drive`, `chat` | no finance data found (grep); broadcast already executive-only | none |
| Frontend | nav and Finance page gated by `Money.canFinance()` (included finance roles); `Money.canSee()` already executive for money figures | `FINANCE_ROLES` and `FINANCE_SENIOR_ROLES` = executive set; lock message updated; the test fails if UI, Edge and SQL sets drift |
| Exports / PDFs | generated in the browser (`finance-pdf.js`) from RLS-protected queries; no server export endpoint exists | protected by the RLS change |
| Storage | no finance/invoice/payroll bucket; no storage policy mentions finance (tested) | gap G2 |
| Realtime | `invoices`, `invoice_payments`, `retainer_plans`, `client_billing`, `expenses` are published; delivery follows RLS | every SELECT policy on them is executive-only (tested by policy inspection, not by a live Realtime session) |
| Legacy PHP / Kite Drive | no finance logic in the repository PHP | gap G3 |

## 3. Who could read Finance data before the fix (source)
finance_manager and accountant: all finance tables, all clients. general_manager: expense approvals and decisions, finance audit events, amounts in claim notifications. Submitters: their own expense rows. HR and ordinary employees: none from the tables; none found elsewhere. **Not verified against the live database.**

## 4. Existing business workflows that break under this policy (not weakened)
1. **finance_manager and accountant lose all Finance work:** invoicing, payments, retainers, billing profiles, settings, expense review, retainer-batch alerts. The Finance page shows "Executives only".
2. **general_manager can no longer approve expenses** (they could approve without being able to read amounts).
3. **Filing an expense claim:** the screen to file one lives on the Finance page, which was already finance-tier only, so ordinary staff never had a UI for it. The API INSERT policy is unchanged, but a claim can no longer be read back, even by its submitter. The approval notification (`expense_decision`) still reaches the submitter; its link goes to the locked page.
4. **Finance roles lose the "see every client" access** added in 017.
5. **Deciding an expense now requires an executive;** the expense approval queue is executive-only.
Nothing was enabled to compensate (see section 6).

## 5. Existing data left untouched (decision needed)
Notifications of type `expense_request` that already carry amounts may sit in the `notifications` table of general_manager, finance_manager, accountant and HR users (a user reads only their own). They were not deleted or redacted (data preserved). Read-only check: `SELECT count(*) FROM notifications WHERE type IN ('expense_request','invoice_drafts');` grouped by the recipient's role.

## 6. Narrowly scoped permissions to consider (NOT enabled; need approval)
Only if operational work requires them; none exposes general Finance data:
- `expense.file`: file an expense claim and see only its own status (needs a small "My claims" view or RPC returning status, no amounts of others).
- `invoice.prepare`: create draft invoices from an executive-defined template without seeing totals or any other invoice.
- `payment.record_intent`: submit a payment-received note for an executive to confirm.
Each would be a named capability checked in the Edge Function and a purpose-built RPC, not a table read.

## 7. Remaining gaps
- **G1** salaries/contracts: no data model yet; `employee_documents` (free-text type, readable by general_manager and HR) must be classified and restricted before any compensation document is stored there.
- **G2** (resolved for the document library by migration 024; see section 10) there is still no dedicated finance bucket; `task-attachments` and `chat-media` follow task/conversation rules and have no link to any financial record.
- **G3** Kite Drive: assessed in section 10; no financial classification exists there, so it cannot be enforced from this repository. Open.
- **G4** live state: whether finance_manager/accountant users exist, the live `auth_is_finance()` body, live policy drift (empty migration history), Realtime behaviour. All NOT VERIFIED.
- **G5** the executive tier now includes equal management of super_admin by owner and ceo (and the reverse); that is the approved policy and is covered by tests.
- **G6** closed by migration 023 (database-level guard, tested on real PostgreSQL); see section 9.

## 8. Production verification checklist (read-only)
1. `SELECT pg_get_functiondef('public.auth_is_finance()'::regprocedure);` before and after: the role list must be exactly super_admin, owner, ceo after.
2. `SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.name IN ('finance_manager','accountant','ceo');` (counts only): who is affected.
3. `SELECT polname, polrelid::regclass FROM pg_policy WHERE pg_get_expr(polqual,polrelid) ILIKE '%auth_is_finance%';` and confirm no `clients_select_finance`, and that `expenses_select`/`expense_approvals_select` use it.
4. For each finance table, `SELECT has_table_privilege('authenticated', 'public.<table>', 'INSERT,UPDATE,DELETE');` must be false (reads are gated by RLS).
5. As a finance_manager test account on staging: every table above returns 0 rows, the Finance page is locked, `finance` returns 403.
6. Count of `notifications` rows with amounts per recipient role (section 5).

---
# Addendum 2026-11-07 (second pass): concurrency, Storage and Drive, notifications

## 9. Last active super_admin: database-level guarantee (migration 023)
- **Problem (reproduced on real PostgreSQL 18):** with only the Edge Function checks (and migration 020, which locks only the role-replace path), two concurrent suspensions or deletions each saw "another super_admin is active", both committed, and zero remained.
- **Fix:** BEFORE triggers on `profiles` (status leaves `active`, or delete), `user_roles` (a super_admin row deleted or re-pointed) and `roles` (the role deactivated, renamed or deleted). They take one transaction-level advisory lock, then count the other active super_admins with a fresh snapshot, and raise `last_super_admin`. `auth.users` deletion cascades into the same triggers. `replace_user_role()` now keeps the same row when re-assigning super_admin.
- **Result:** every pair of {suspend, delete profile, delete auth user, demote, delete role row} run on two real connections keeps exactly one active super_admin; the second request provably waits for the first; a three-way randomized stress (40 rounds) never dropped below one; no over-blocking with three active super_admins; ordinary employees unaffected.
- **Limits:** assumes READ COMMITTED (PostgREST/Edge default). A superuser can bypass with `session_replication_role = replica`; TRUNCATE is not guarded. If no super_admin exists, nothing is guarded (bootstrap).

## 10. Storage and Kite Drive audit
| Path | Finding | File : line | Status |
|---|---|---|---|
| Document library `assets` (+ `studio-assets` bucket) | **Confirmed leak:** a free-text "Contracts" folder exists; files there were studio-wide by default and `assets_select` showed every file, private ones included, to every admin (incl. general_manager). No column linked a file to a financial record | `js/modules/documents/documents.js:18`, `supabase/migrations/007_assets_and_realtime.sql:42-55` | **Fixed in 024**: `assets.finance_confidential`, set automatically for Contracts (fail-closed: the folder name can only restrict), executive-only read, create, edit and delete; existing Contracts rows flagged; the UI hides the folder from non-executives |
| Storage read of those files | follows `assets` visibility via `studio_assets_read` | `007_assets_and_realtime.sql:80-83` | 024 makes it follow the flag; see the pre-existing bug below |
| Signed URLs | browser `createSignedUrl(s)` requires the storage SELECT policy, so RLS applies; lifetimes 120 s (downloads) and 3600 s (lists) | `documents.js:150,269`, `client-hub.js:503`, `tasks.js:864`, `chat.js:858` | URLs issued before a file is flagged live until they expire (max 1 h) |
| `client-preview` (public share link) | signs `content_post_assets` with the service role, not library `assets`; the content-plan module never reads the library | `client-preview/index.ts:50` | no path from a confidential library file to a public link; unchanged |
| `task-attachments`, `chat-media` | access by task visibility / conversation membership; no link to finance tables | `004_storage.sql:31-46`, `016_chat_v2_private_and_media.sql:117-130` | no finance relationship found |
| `expenses.receipt_path` | column exists; **no code or bucket writes it** | `001_initial_schema.sql:538` | latent: a receipt feature must reuse the executive-only flag or a dedicated bucket |
| Kite Drive Edge Function | anyone who can see the client (clients RLS) gets read/list/download/view tokens; `isDriveAdmin` = admins + ceo (includes general_manager) can upload and relink; token lifetimes 120-1800 s | `kite-drive/index.ts:26,55,58,104` | no finance classification exists; **open (G3)** |
| Kite Drive PHP | HMAC token (max 1 h, bound to one Drive client) gates `list` L479, `download` L550, `view` L569, `tree` L595, `mkdir` L605, `move` L661, `delete` L684, uploads L975+; `file.php` requires a Drive login and restricts clients to their own files | `integrations/kite-drive/api/index.php:11,48`, `file.php:22,37` | the repo has no notion of confidential or finance files in Drive, and `db.php`/`auth.php` are not in the repo; contracts stored there cannot be restricted from here |
| **Pre-existing bug (not caused by ARC-01)** | the 007 read policy compares `a.storage_path = name`; inside that subquery `name` is `assets.name`, so as written it matches **no object for anyone** (fails closed; demonstrated by a test). The live policy may have been edited; **not verified**. 009's equivalent policy is fine because `content_post_assets` has no `name` column | `007_assets_and_realtime.sql:83` | **reported, not changed** (changing it alters live access semantics). Suggested one-line fix `a.storage_path = objects.name`, to be approved separately; check live with `SELECT qual FROM pg_policies WHERE policyname='studio_assets_read'` |

## 11. Existing financial notifications
- **Generators:** `workflow expense.submitted` (type `expense_request`, content `"<who>: <title> (EGP <amount>)"`), `retainer-billing` (type `invoice_drafts`, content `"<N> draft invoices created for <month>"`). `expense_decision` carries only the submitter's own claim title. No SQL trigger writes notifications. Push text equals the notification text.
- **Who could read them:** a user reads only their own rows (`notifications_select`, `002_rls_policies.sql:763`). Historic recipients: `expense_request` to super_admin, owner, **general_manager, finance_manager, accountant**; `invoice_drafts` to **finance_manager, accountant**, owner, super_admin. Existing rows may still sit in those users' feeds (not verified live).
- **Prevention (previous pass):** new notifications of both types go to executives only (tested).
- **Redaction (migration 025, a data change, apply only on owner approval):** for those two types and non-executive recipients only, replace `content` with a generic sentence; keep id, user, type, title, link, read state, metadata and `created_at`; delete nothing; originals saved to `finance_backup.notifications_pre025` (unreachable through the API); idempotent; rollback SQL in the header; tested to leave executives', other types' and all other columns identical.
- **Cannot be undone:** push messages already shown on devices.
