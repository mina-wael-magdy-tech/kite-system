# 10 — Bugs & architectural defects

Scope caveat: backend and Drive were read; browser modules were not (see `coverage/`). Confidence: **Confirmed** = behaviour follows directly from code read; **Plausible** = needs runtime/other-code check.

---
## SEC-01 — MEDIUM — Public client-preview endpoint is weakly throttled and lets a link holder change plan state
- **Module:** Content plans · **File:** `supabase/functions/client-preview/index.ts` (const L17; feedback branch ~L87–130) · `supabase/config.toml` L69–70 (`verify_jwt = false`)
- **Implemented:** Anyone with the 192-bit token can call `feedback` / `approve_all`. The only throttle is `MAX_FEEDBACK_PER_HOUR = 60` counted **per plan** (a `count` query, then a separate `insert` — not atomic). `approve_all` sets `content_plans.status = 'approved'` and `kind: change` sets `changes_requested` with no confirmation or idempotency. Each accepted submission calls `notify()` for **every** admin-role holder plus creator/publisher, and `notify()` also fans out Web Push.
- **Expected:** a public, unauthenticated write path should be limited per client/IP, atomic, and its blast radius (notifications, status) bounded.
- **Impact:** a leaked/forwarded link (forwarding is the intended use) lets a third party (a) approve or reject a plan, (b) generate up to 60 × (admins+2) notifications/pushes per hour per plan, and (c) fill `content_feedback`. Concurrent requests can exceed 60 because count and insert race. Not a data-exfiltration issue: `get` returns only presentation fields and signed image URLs valid 1 h.
- **Reproduce (not executed):** POST `{action:"approve_all", token, name:"x"}` repeatedly; observe status flips and notification inserts.
- **Fix:** per-IP + per-token sliding window (DB counter with unique window key or insert-then-count); make `approve_all` a no-op when already approved; optionally require a short per-link PIN; cap notifications per plan per hour (coalesce); allow staff to revoke (`enabled=false` exists — confirm UI exposes it). **Confidence:** Confirmed (code); exploitability depends on link distribution.

## SEC-02 — MEDIUM — Drive tokens accepted in the query string
- **File:** `integrations/kite-drive/api/index.php` L447–449
- **Implemented:** for `download|view|thumb|zip|logo` the HMAC token is read from `?token=`. Lifetimes 120–600 s and scope-limited (`download` is bound to one `fid`; `view` is bound to the client).
- **Impact:** tokens land in Hostinger access logs, browser history, any proxy, and possibly `Referer` of pages opened from a viewed file. A `view` token (10 min) exposes every file of that client for 10 min to whoever reads the log in time. The code comment acknowledges the trade-off (`<img>` can't send headers).
- **Fix:** exchange the token for a short-lived cookie scoped to `/api/`, or issue per-file one-time URLs (`fid` + nonce, single use); keep `Referrer-Policy: no-referrer` on Drive responses; exclude `token` from access logs. **Confidence:** Confirmed.

## ARC-01 — MEDIUM — Role sets are duplicated in three layers and already disagree
- **Evidence:** SQL `auth_is_admin` = super_admin/owner/**general_manager** (`002_rls_policies.sql` L78); `auth_is_owner` = super_admin/owner/**ceo** (`015…sql` L22); `auth_is_finance` adds ceo + finance roles (`017…sql` L30); Edge `ADMIN_ROLES` = super_admin/owner/general_manager (`_shared/auth.ts` L5); `kite-drive` special-cases `ceo` (`index.ts` L55: "ceo sees all clients under 015 but isn't in ADMIN_ROLES"); JS `permission-service.js` L72 and L83 repeat both lists; `broadcast.js` L14 and `services/money.js` L10 repeat the owner list.
- **Impact:** every new role or rename requires edits in ≥6 places; a miss yields either access denied for a legitimate person or (worse) a role allowed in one layer and not another. The `ceo` role is referenced everywhere but not created by `seed.sql` or migrations read (unverified live).
- **Fix:** single source (a `roles` capability column or an `auth_capabilities()` SQL function); Edge Functions and the browser read it rather than hard-coding names. **Confidence:** Confirmed (drift), impact Plausible.

## DAT-01 — MEDIUM — `link.create` writes to two systems without compensation
- **File:** `supabase/functions/kite-drive/index.ts` L177–205
- **Implemented:** creates the Drive account (`create_client` on Hostinger) first, then upserts `client_drive_links`. If the upsert fails (DB error, or `23505` because that Drive id was linked meanwhile) the Drive account and password hash remain with no link and no cleanup; the admin retrying hits 409 "email exists" on Drive.
- **Impact:** orphan Drive accounts; confusing retry failures. `link.set` uses `upsert` so it silently re-points an already-linked client (audited with `oldData`, admin-only).
- **Fix:** on link failure call a Drive `delete_client` (needs adding) or make link creation idempotent by email lookup. **Confidence:** Confirmed.

## OPS-01 — MEDIUM — Scheduled jobs live outside the repo; no heartbeat
- **Files:** `functions/due-reminders/index.ts` L1–10, `functions/retainer-billing/index.ts` L1–12 (instructions say "schedule from the Supabase Dashboard").
- **Impact:** if the cron entry is missing, deleted, or `CRON_SECRET` rotated, task digests and monthly retainer drafts stop with no error anywhere. Retainer invoices *not being generated* is a revenue-visible silent failure. Both functions are idempotent (20 h digest guard; per-plan-per-month uniqueness per header comment), so a re-run is safe.
- **Fix:** commit cron definitions (`pg_cron`/`pg_net` SQL migration) and add a "last successful run" row + alert. **Confidence:** Confirmed (design); live state unverified.

## OPS-02 — MEDIUM — No CI; security regression tests are manual and partial
- **Evidence:** no `.github/`; `supabase/tests/verify-rls.mjs` names migrations 001–005, 016, 017 only; no tests for Edge Functions, PHP, or browser code. Key controls added in 012 (post guard), 015 (owner-only money, client scope) and 019 (drive links) have no named test in the harness.
- **Fix:** CI job running the harness over all migrations in order, plus Deno tests for `getCaller` authorization matrix and a PHP token-verification test. **Confidence:** Confirmed for "not named"; indirect coverage unverified.

## DAT-02 — LOW — Legacy money columns remain and are silently zeroed
- **File:** `015…sql` (`blank_money_columns` trigger on clients/projects/campaigns/departments/leads/opportunities).
- **Impact:** any UI/API still writing `budget`/`value`/`monthly_budget` has its value discarded without error; reporting code reading these columns gets 0/NULL. Correct by design for secrecy but confusing and fragile.
- **Fix:** drop the columns after confirming no reader; or raise an exception in dev. **Confidence:** Confirmed.

## SEC-03 — LOW — Notification triggers replayable
- **File:** `workflow/index.ts` L582–L615 (`leaveSubmitted`, `expenseSubmitted`): ownership and `pending/submitted` status checked, then a 10-minute window (L586, L603) — but no "already notified" marker.
- **Impact:** the submitter can re-call within 10 min to re-notify all approvers. Nuisance only. **Fix:** write a `notified_at` or dedupe via notifications metadata.

## SEC-04 — LOW — Body-size guard
- **File:** `_shared/http.ts` L44–46: `await req.text()` reads the whole body before comparing `text.length` (characters). Platform limits apply, but the guard is not a real bound and multi-byte text exceeds `maxBytes` bytes. `finance` allows 200 000. **Fix:** check `Content-Length` first / stream with a cap.

## SEC-05 — LOW — Large `innerHTML` surface
- **Evidence:** 163 `innerHTML` occurrences in `js/` vs 429 `escapeHTML(` calls; heavy users `hr.js` (13), `tasks.js` (11), `projects.js` (5). CSP forbids inline script (`script-src 'self'`), so injected markup cannot run script; `style-src 'unsafe-inline'` remains.
- **Status:** **not reviewed per site**. Treat as risk, not defect. **Fix:** lint rule banning un-escaped template interpolation; central `html` tagged template.

## OPS-03 — LOW — Unbounded Drive side files
- **Files:** `api/index.php` L218–229 (`_log/actions.log` append-only, never rotated); `send.php` thumbnail cache `_thumbs/<id>-<mtime>.jpg` (new file whenever `mtime` changes; deleted only on file delete). `_chunks` stale cleanup is time-based (2 days) and runs only when `remove_stale_uploads()` is invoked (call site not confirmed).

## DAT-03 — LOW (unverified) — Client deletion vs finance data
- `clients_delete` is allowed to admin tier from the browser (`002` L345–347, grant L203). `client_billing`, `client_drive_links`, `client_activities`, contacts, leads cascade; `invoices.client_id` is `ON DELETE SET NULL` in 001 but 017's `fin_invoice_guard` (L345–354) rejects `client_id` changes and `017` L95 declares `retainer_plans.client_id ... ON DELETE RESTRICT`. Net effect (error vs orphan) depends on trigger/cascade ordering — **test on scratch DB**. Also deleting a client leaves its Drive account and files on Hostinger (link row cascades, Drive untouched).

## Technical debt / informational
- `supabase/seed-finance-demo.sql` and `maintenance/remove-test-data.sql` ship in the repo (demo/test data tooling) — ensure never run on live.
- `docs/finance-poc/*.pdf/png` proof-of-concept artifacts committed.
- Untracked `supabase/tests/package-lock.json` (git status).
- `js/config.js` comment says 50 MB general limit while docs mention 25 MB task bucket — consistent but duplicated constants (must match SQL `004_storage.sql`).
- `README` badge claims "Production Ready"; the repo has no CI, monitoring or test coverage evidence.
- No TODO/FIXME markers found (grep).
- Dual write path: browser writes `expenses`, `leave_requests` directly (RLS INSERT) and then calls `workflow` to notify (`finance.js` L318, `hr.js` L549); tasks are read-only to the browser (`GRANT SELECT` only, `002` L237) — good. Other tables' direct-write rules were not enumerated.

## Checked and found sound (evidence-based, so you don't re-audit)
- `getCaller` verifies the JWT server-side with `auth.admin.getUser`, loads roles from DB, requires `employment_status='active'` for every privilege (`_shared/auth.ts` L44–83).
- CORS fails closed when `ALLOWED_ORIGINS` is unset; POST-only; errors masked (`_shared/http.ts`).
- `setup-admin`: constant-time token compare, atomic lock row, refuses if a super_admin exists, rollback on failure.
- Cron functions: `CRON_SECRET` ≥24 chars, constant-time compare.
- PHP token verification: HMAC-SHA256 with `hash_equals`, `aud` check, lifetime cap 3600 s, scope check, client-id binding, deleted-client check, strict base64url (`index.php` L48–75, L452–458).
- Drive upload: extension denylist checks every dotted part; random storage name; MIME via `finfo`; `uploads/.htaccess` denies script extensions; `drive_resolve_path` uses `realpath` + prefix check; zip extraction ignores `..`, caps entries/size, bounds stream copy; inline serving restricted to safe MIME list, SVG sandboxed, `nosniff`.
- SQL: default privileges revoked from anon/authenticated (`002` L28–33); column-level grants on profiles; `SECURITY DEFINER` functions pin `search_path = ''`; finance writes only via service-role `fin_*` functions with `FOR UPDATE` row locks, audit triggers and delete blocks.
- Build refuses a `service_role` key in `SUPABASE_ANON_KEY` (`scripts/build.mjs`).
