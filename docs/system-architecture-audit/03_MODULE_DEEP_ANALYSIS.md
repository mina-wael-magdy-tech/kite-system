# 03 — Module analysis

**Depth warning:** only modules marked ● were traced from code; ○ are described from Graphify structure, file size, and DB/function names and have **not** been read line by line. Do not treat ○ entries as verified behaviour.

Graph hubs (Graphify): `getSupabase()` 118 edges · `escapeHTML()` 94 · `ChatModule` 59 · `DrivePanel` 50 · `ContentPlanEditor` 46 · `formDialog()` 45 · `TasksModule` 32 · `CallService` 30 · `Toast` 29 · `confirmDialog()` 28.

## ● Kite Drive integration
- **Purpose:** show/manage a client's files that live on Hostinger without moving them.
- **Files:** `js/modules/clients/drive-panel.js` (904), `supabase/functions/kite-drive/index.ts`, `migrations/019_kite_drive_links.sql`, `integrations/kite-drive/{api/index.php,api/send.php,file.php}`, `docs/kite-drive.md`.
- **Tables:** `client_drive_links(client_id PK→clients CASCADE, drive_user_id UNIQUE, drive_name, linked_by, linked_at)`; RLS on, **no policies, no grants** → service role only.
- **Trace (browse a file):** user opens client → `DrivePanel` → `callFunction('kite-drive',{action:'token',scope:'read',clientId})` → Edge: `getCaller` (JWT→profile→roles, active) → `requireStaff` → `visibleClient` (user-scoped select on `clients`; RLS `auth_can_see_client`) → read link via service role → sign `{aud,sub,scope,cid,fid?,iat,exp}` HMAC-SHA256 (TTL: admin 300, read 600, write 1800, download 120, view 600 s) → browser calls `${KITE_DRIVE_URL}/api/index.php?action=list` with `X-Drive-Token` (CORS allow-list in `config.php`) → PHP `verify_token`, client exists, query scoped by `user_id = cid` → JSON.
- **Permissions:** browse/download = anyone who can see the client (RLS scoping: owner/ceo all; others by department, account manager, creator); upload/link/account edit = `isAdmin || ceo`.
- **Validation:** Edge: `uuid`, `oneOf`, `positiveInt`, `email`, `text` lengths. PHP: ids via `FILTER_VALIDATE_INT`, name sanitising, blocked extensions, MIME by `finfo`, chunk id regex `^[a-f0-9]{32}$`, per-client ownership asserts on folders/files.
- **Events/side effects:** `audit_logs` rows (`kite_drive.link|unlink|account_update`); Drive `_log/actions.log` JSON lines (who = Supabase user UUID).
- **Tests:** none.
- **Concerns:** SEC-02, DAT-01, OPS-03; account password flows through Edge Function (never stored, hash by Drive; not logged).

## ● Auth & invitations
- `js/auth/*`, `accept-invitation`, `invite-employee` (○), `setup-admin`, `invitations` table, `templates/invite.html`.
- Trace: admin invites (`invite-employee` ○) → user opens link → sets password in `invitation.html` → `accept-invitation`: caller must be `onboarding`; pending non-expired invitation for their email; conditional update `employment_status: onboarding→active` (race-safe); invitation marked accepted; admins + HR notified; audit.
- Bootstrap: `setup-admin` (see `10` "found sound").
- Concern: none found in code read; client-side `login.js` / `auth-guard.js` not reviewed.

## ● Tasks (+ `workflow`)
- UI `modules/tasks/tasks.js` (1081); rules in `workflow/index.ts`: `TRANSITIONS` map, review-gated moves to `approved|completed`, reviewer = admin | creator-not-assignee | department manager | project manager; assignee must be active internal staff; visibility = RLS via `userClient`.
- Browser has **SELECT only** on `tasks` (`002` L237) so the state machine cannot be bypassed from the console.
- Tables: `tasks`, `task_assignees`, `task_checklists(+items)`, `task_comments`, `task_attachments`, `task_activity_logs`, `task_handoffs`, `task_links`, `task_time_entries`.
- Background: `due-reminders` daily digest.
- Not verified: UI-side handling of failed transitions; comments/attachments write paths.

## ● Finance & invoicing
- UI `modules/finance/*` (○), function `finance` (●head), SQL `017` (●structure).
- Pattern: browser never sends totals; `fin_invoice_save` computes in NUMERIC, `fin_invoice_issue` assigns gapless sequential numbers (`invoice_number_seq` table + `FOR UPDATE`), issued invoices frozen by `fin_invoice_guard`, invoices/payments undeletable (`fin_block_change`), reversal via `fin_payment_reverse`, audit via `fin_audit` triggers into append-only `finance_audit_log`. Functions executable only by `service_role` (`017` L731–732). RLS select via `auth_is_finance()`.
- Overlap with 015: `invoices` etc. were made owner-only in 015; 017 adds finance-tier select policies (OR semantics) — intended broadening for accountants.
- Retainers: `retainer_plans` + `retainer-billing` cron.

## ● Content plans / client preview
- Staff UI: `campaigns/content-plan.js` (1094), `pptx-export.js`, `utils/plan-slide.js`; tables `content_plans`, `content_posts`, `content_post_assets`, `content_feedback`, `content_plan_shares`.
- Public: `preview.html` + `js/preview/preview.js` → `client-preview` function (see SEC-01).
- DB guards (012): publisher may only change status/published fields (`content_posts_guard`); asset paths must match uploader+plan folder; client feedback immutable except resolved flags.

## ○ Chat & calls
`chat.js` (1194), `call-service.js` (WebRTC, 488), `realtime-service.js`, function `chat`, tables `conversations`, `conversation_members`, `messages`, `message_attachments`, `message_reactions`; 016 adds private conversations and media; 018 typing indicator. Admin-only channel management; staff DMs/messages; authors edit/delete (admins can delete). Calls: `call.start` posts a call card and notifies members; media is peer-to-peer (needs TURN for strict networks per docs).

## ○ Clients / Client Hub / CRM
`client-hub.js`, `clients/*`, `crm.js`; tables `clients`, `client_contacts`, `client_departments`, `client_activities`, `leads`, `opportunities`; scoped by `auth_can_see_client` (015). Money values moved to owner-only `money_figures`.

## ○ HR / Employees / Departments
`hr.js` (572), `employees.js`, `departments.js`; tables `profiles` (column-level GRANTs), `attendance_records`, `leave_requests/leave_types`, `employee_documents`, `holidays`, `user_departments`; decisions through `workflow` (`leave.decide`, `employee.update`).

## ○ Projects, Campaigns, Calendar, Documents, Reports, Dashboard, Admin, QR, Broadcast
Described by name/size only. Broadcast: function enforces hourly rate limit and audit; sender roles also hard-coded in JS (`broadcast.js` L14). QR generator runs fully client-side (localStorage "recent" list).

## ● Notifications & Push
`notify()` in `_shared/auth.ts`: insert into `notifications` then `sendPush` (no-op without VAPID). `push_subscriptions` table; endpoint allow-list helper `isAllowedPushEndpoint` (SSRF guard — body not read). Browser: `push-service.js`, `sw.js`.
