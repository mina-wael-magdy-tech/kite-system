# Unverified risks and coverage limits

Evidence classes: **Source-confirmed** (code/SQL read), **Runtime-confirmed in this audit** (only: RLS suite 153/0), **Not verified**.

## Not verified (live state)
| Area | What is unknown | Why it matters | Check (VERIFICATION_PLAN) |
|---|---|---|---|
| Live RLS and grants | Live policies may differ from migrations (live migration history is empty, migrations applied by hand) | Entire read-security model | A1, A2, A5, A6, A7 |
| `ceo` role | Whether it exists live and who holds it | Decides whether ARC-01's HR escalation is exploitable now | A3, A4 |
| Cron | Whether the two daily jobs exist, run and succeed | OPS-01 | B1-B3 |
| Secrets/config | ALLOWED_ORIGINS, APP_URL, SETUP_TOKEN removed, setup-admin deleted | Availability and bootstrap exposure | C1, C2 |
| Backups/restore/monitoring | Any evidence at all | Data-loss recovery | OPS-04, E6 |
| Database time zone | UTC vs Cairo | FUN-02 | A8 |
| Data quality | Invalid leave rows, expense currency, asset paths, duplicate DMs, orphans | DAT-04/06/08/09, SEC-06 | A9-A12 |
| Performance | Query plans, index coverage, table sizes | PERF-01..04 | A13-A15, E1 |
| Hostinger | PHP limits, mod_rewrite, log retention, backups | SEC-02, OPS-03, PERF-04 | E1-E6 |
| Notion specification | The Kite System page is empty; no requirement list exists | FUN-03, FUN-05, SEC-08, DAT-04 leave-day rule, ARC-01 role intent cannot be settled | fill the spec |

## Not read or only sampled (source)
- Browser modules were read in part: router, auth, preview, realtime service, notification service, helpers, linkify, dialogs, and targeted regions of chat, hr, finance, drive-panel, tasks. The remaining ~20k lines of module code were scanned by script (call sites, `innerHTML`, listeners, query bounds), not read line by line.
- Kite Drive PHP `api/index.php` actions after line 470 were only grepped; the legacy `db.php` and `auth.php` are not in the repository.
- Migrations 003, 005, 006, 008, 010, 011, 013, 014, 018 were not read in full; 009 and 016 only the policy/storage parts.
- `push.ts` and `validate.ts` were read in full this pass; every Edge Function has now been read at least once, `workflow` and `chat` fully.
- Graph edges are static; none is a confirmed runtime dependency.

## Executed in this audit
- `node verify-rls.mjs` in `supabase/tests` (in-process Postgres, no network, no production access): 153 passed, 0 failed. It applies only migrations 001-005, 016, 017.
- Graph and register validation scripts (offline).

## Candidate risks not promoted to issues (insufficient evidence)
| Candidate | Reason not an issue |
|---|---|
| `linkify` / `escapeHTML` XSS | Read and found correct (see SEC-05) |
| Planting `task_attachments.storage_path` to read another task's files | Storage read policy keys on the path prefix task id, not on the row: not exploitable |
| Invoice lines deletable on issued invoices | `fin_item_calc` guards INSERT/UPDATE only and there is no DELETE trigger on `invoice_items` (017 L415, L423-L428), but browser roles have no write grant, so only the service role or a SQL-editor session can do it. Recorded here, not as an issue; if desired, add a DELETE guard inside FX-15 |
| `app.migrating` GUC bypassing finance guards | Not settable through the API; only a risk for manual SQL sessions that fail mid-script (migration 017 sets it with a session-level `set_config(...,false)`). Recommend `SET LOCAL` in a transaction when 017-style scripts are re-run; covered by the manual-migration process under FX-02/FX-03 |
| Preview `get` leaking internal fields | Fields are whitelisted in the function (read) |
