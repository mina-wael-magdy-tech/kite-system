# 05 — API & communication architecture

All Edge Function endpoints: `POST https://<ref>.supabase.co/functions/v1/<name>`, JSON body `{action,...}`, response `{success:true,...}` or `{error}`; `Cache-Control: no-store`; CORS only for origins in `ALLOWED_ORIGINS`; unknown action → 400; non-HttpError → generic 500. No per-endpoint HTTP verbs/URLs (RPC-over-POST), which is consistent across functions.

## Edge Function actions
| Function | Actions | Authz | Side effects |
|---|---|---|---|
| workflow | task.create/set_status/reassign/update/delete/comment/file_added, employee.update, expense.decide/submitted, leave.decide/submitted, push.subscribe/unsubscribe/test | staff; per-action reviewer/admin/HR rules | tasks, logs, notifications, audit, push |
| chat | channel.create/update/members/archive/delete, dm.create, message.send/edit/delete, reaction.toggle, call.start | admin / staff / author | messages, notifications, audit |
| finance | settings.update, billing.save, plan.save, invoice.save/issue/void, payment.add/reverse, retainer.run | finance tier; void/reverse/settings senior | `fin_*` RPC, audit |
| kite-drive | status, token, link.options/set/create/remove/account/update | staff + RLS visibility; admin for changes | `client_drive_links`, Drive API calls, audit |
| client-preview | get, feedback, approve_all | share token (public) | feedback rows, plan status, notifications, audit |
| accept-invitation | (none; single purpose) | onboarding user | profile activation |
| setup-admin | (single) | `SETUP_TOKEN` | first super admin |
| due-reminders, retainer-billing | (single, cron) | `CRON_SECRET` | notifications / invoices |
| broadcast, content-plan, invite-employee | not read | | |

## Kite Drive PHP API (`/api/index.php?action=…`)
Auth: HMAC token (`X-Drive-Token` header; query `token` for `download|view|thumb|zip|logo`). Actions: `clients`(admin), `list`, `download`, `view`, `thumb`, `tree`, `mkdir`, `ensure_path`, `rename`, `move`, `delete`, `zip_prepare`, `zip`, `logo`, `logo_set`, `create_client`, `client_account`, `update_client`, `upload_init|chunk|complete`; unknown → 404 `Unknown action`. Scope enforcement via `require_scope` per action (bodies 470+ grepped, not all read). Methods: GET/POST/OPTIONS; CORS origin allow-list; `X-Content-Type-Options: nosniff`.
Also `file.php`: session-login check for direct `/uploads/*` links (legacy Drive users).

## Direct table API (PostgREST, RLS)
162 `.from()` sites in browser. Writes allowed where grants exist (e.g. `expenses` INSERT, `leave_requests` INSERT, `notifications.is_read` UPDATE, `profiles` self-update on whitelisted columns, `attendance_records` check-out). Not enumerated fully — see `UNVERIFIED_AREAS`.

## Observations
- **Contract mismatches / unused endpoints:** not assessable without frontend reading. `link.options`, `link.set`, `link.account`, `link.update` exist; UI use not verified.
- **Pagination:** commit `ad3afc2` "Add pagination across the system and to Kite Drive"; PHP `list` has `$fileLimit`; `ITEMS_PER_PAGE = 20`. Full coverage unverified.
- **Rate limiting:** only `broadcast` (hourly) and `client-preview` (per plan hourly). No generic limiter; Supabase platform limits apply.
- **Error format** consistent in Edge (`{error}`); PHP uses `{error, ...extra}`.
- **Excessive payloads:** `finance` allows 200 kB bodies; `readJson` guard weak (SEC-04).
- **Trust:** the browser is never trusted for roles (Edge loads roles from DB each call).
- Diagram: `diagrams/API_COMMUNICATION.mmd`.

## Dependency matrix (function → resources)
| | profiles/user_roles | tasks* | invoices/fin_* | clients | drive_links | notifications | Storage | External |
|---|---|---|---|---|---|---|---|---|
| workflow | R | RW | | R(RLS) | | W | | push services |
| chat | R | | | | | W | | push |
| finance | R | | RW (RPC) | R | | | | |
| kite-drive | R | | | R(RLS) | RW | | | Drive PHP |
| client-preview | | | | R | | W | R (signed URLs) | push |
| accept-invitation | RW | | | | | W | | |
| due-reminders | R | R | | | | W | | push |
| retainer-billing | R | | RW (RPC) | | | W | | push |
