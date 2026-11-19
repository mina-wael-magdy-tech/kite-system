# 08 — Business workflows

Only workflows traced through backend code are included. Frontend entry points are named from Graphify/file names; their internals were not read. Sequence diagrams: `diagrams/SEQUENCE_DIAGRAMS/`.

## W1 — Employee invitation → activation (backend ●, UI ○)
Trigger: admin invites (`invite-employee`, not read) → `invitations` row `pending`, auth user created in `onboarding` (inferred). User opens email link (`invitation.html`/`js/auth/invitation.js`, `checkInviteSession`) → sets password → `accept-invitation` → status `active`, invitation `accepted`, admins/HR notified, audited.
Failure paths: no pending invite → 409; expired → invitation marked `expired`, 410; already active → 409 (conditional update).
Edge: invitation matched by lowercase email only; two pending invitations → latest wins.
Partial-success risk: `invitations` update and notifications happen after the profile activation without a transaction; a crash between leaves invitation `pending` while profile `active` (later accepted calls get 409). Low impact.

## W2 — Task lifecycle (●)
UI → `workflow task.set_status` → caller (active staff) → task loaded through caller's RLS (404 if invisible) → transition must be in `TRANSITIONS` (admins may override) → `approved|completed` require a reviewer → conditional update (race-safe) → `task_activity_logs` + notifications + audit. Reassign requires reviewer rights and an active internal assignee.
Failure: invalid transition → 4xx with message; log/notification failures are logged, not blocking.

## W3 — Expense / leave (●)
Submit: browser inserts row under RLS (`expenses`/`leave_requests` INSERT policy) → then calls `workflow expense.submitted|leave.submitted` to notify approvers (ownership + status + ≤10 min check). Decide: `workflow expense.decide|leave.decide` by approvers (admin/HR/finance). 
Gaps: if the notify call is lost (network/tab close) the approver is never told — row exists with no notification and no retry (partial operation). Replay allowed within 10 min (SEC-03).

## W4 — Invoice → payment → overdue (●structure)
`finance invoice.save` (draft, server-calculated) → `invoice.issue` (gapless number, frozen) → `payment.add` (locks invoice `FOR UPDATE`, status refreshed) → cron `fin_mark_overdue` → void/reverse by senior roles with reason. Retainers: cron generates monthly draft; a person reviews & sends.
Failure: all-or-nothing inside each SQL function; Edge wrapper maps errors.

## W5 — Content plan review by client (●)
Staff creates plan/posts/visuals (RLS + 012 guards) → enables share link (`content_plan_shares`, token, optional expiry) → client opens `preview.html#token` → `client-preview get` (signed image URLs 1 h) → notes/changes/approvals → rows in `content_feedback`, plan status updated, notifications to admins/creator/publisher, audit.
Edge cases: token disabled/expired → 404/410; rate limit 60/h per plan (SEC-01). Post-approval edits by staff are not blocked by status (not verified).

## W6 — Kite Drive link & file access (●)
See `03` and `SEQUENCE_DIAGRAMS/kite-drive-token.mmd`. Link create/set/remove admin-only and audited; browse/download any staff who can see the client; upload admin-only; tokens ≤30 min.
Failure: Drive down → 502 "Couldn't reach Kite Drive"; not configured → 503; DAT-01 on partial link creation.

## W7 — Daily automation (●) — see `07` #1 and #2.

## Not traced (○): registration of clients, CRM lead→opportunity→client, attendance, chat message send, calls, broadcasts, reports/exports (PPTX/PDF), QR.
