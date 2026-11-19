# 07 — Hidden systems & background processes

| # | Process | Trigger | Defined | Reads → writes | Sync? | On failure | Retry | Duplicate-safe | Monitoring | Can silently stop? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Daily task digest** `due-reminders` | HTTP cron (Supabase Dashboard → Cron) with `x-cron-secret` | `functions/due-reminders/index.ts` | `tasks` (non-final, assigned, due ≤ tomorrow) → `notifications` (+push), `audit_logs` | single run | 500; nothing retried automatically | next day's run covers it | **yes**: skips users with a `due_digest` in last 20 h | none | **Yes** — schedule isn't in repo (OPS-01) |
| 2 | **Daily retainer billing** `retainer-billing` | same cron mechanism | `functions/retainer-billing/index.ts` → `fin_retainer_generate`, `fin_mark_overdue` | `retainer_plans`, `invoices` → draft invoices, overdue status, notifications to finance | single run | throws on generate failure; mark-overdue failure only logged | next day | per-plan-per-month uniqueness (per header + function; verify in 017) | none | **Yes**; revenue-visible |
| 3 | **Notification fan-out** | any Edge action calling `notify()` | `_shared/auth.ts` | → `notifications`, then `sendPush` | inline (adds latency to user action; push failure handling in `push.ts`, unread) | insert failure is logged and push skipped | none | not deduped (SEC-03) | none | push silently no-op if VAPID missing |
| 4 | **Audit trail** | `audit()` calls; DB `fin_audit` triggers | `_shared/auth.ts`, 017 | → `audit_logs`, `finance_audit_log` | inline | **audit insert failure is logged and swallowed** (action still succeeds) for Edge audits; finance trigger audits are transactional | none | n/a | none | Edge audit can be lost silently |
| 5 | **DB triggers that rewrite data** | INSERT/UPDATE | `003` updated_at; `012` `content_posts_guard`; `015` `blank_money` (zeroes budget/value columns); `017` finance calc/guards/no-delete | | sync | exception to caller (guards) or silent rewrite (`blank_money`) | | idempotent | | n/a |
| 6 | **Realtime subscriptions** | browser | `realtime-service.js`, migrations 007/018 publication | chat/notifications | async | reconnect behaviour unread | | | | tab-dependent |
| 7 | **Service worker** | page load | `sw.js` (stamped by build) | caches static files | async | falls back to offline page | | | | stale shell if build stamp missing (build fails if placeholders absent) |
| 8 | **Push subscription lifecycle** | user action | `workflow` push.* , `push-service.js` | `push_subscriptions` | | | | | | expired subscriptions cleanup not confirmed |
| 9 | **Drive stale-upload cleanup** | called from API (`remove_stale_uploads`, call site unconfirmed) | `api/index.php` L405–412 | deletes `_chunks/*` older than 2 days | inline | | | yes | none | only runs when API is exercised |
| 10 | **Drive thumbnail cache / action log** | on first thumbnail view / every change | `send.php`, `index.php` | `_thumbs/`, `_log/actions.log` | inline | `@`-suppressed errors | | | none | grows unbounded (OPS-03) |
| 11 | **Invitation expiry** | lazy, on accept | `accept-invitation` | marks invitation `expired` only when someone tries to accept | | | | | | expired invitations stay `pending` until used |
| 12 | **Setup lock** | first admin bootstrap | `setup-admin` | `company_settings.setup_lock` | | rollback deletes lock | | atomic | | function should be deleted after use (documented) |

## Hidden cross-module dependencies
- Retainer cron → Finance data → Notifications → Push (four modules from one invisible trigger).
- Client-preview feedback (public) → `content_plans.status` → notifications to admins/creator/publisher.
- Client deletion → cascades into drive links, billing, activities (and nothing on Drive).
- `blank_money` trigger → any module still writing budgets sees values vanish; money lives in `money_figures`.
- `ALLOWED_ORIGINS` unset → every browser→function call fails (fail-closed), looks like "backend down".
- Features that look complete in the UI but need external setup: push (VAPID + HTTPS), calls across NAT (TURN), reminders (cron + secret), retainers (cron), Kite Drive (two secrets, CORS list on Hostinger, URL).
