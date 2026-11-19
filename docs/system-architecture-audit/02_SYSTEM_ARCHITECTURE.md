# 02 — System architecture (reconstructed)

Diagrams: `diagrams/SYSTEM_CONTEXT.mmd`, `CONTAINER_ARCHITECTURE.mmd`, `COMPONENT_ARCHITECTURE.mmd`, `FRONTEND_ARCHITECTURE.mmd`, `BACKEND_ARCHITECTURE.mmd`, `DEPLOYMENT_ARCHITECTURE.mmd`.

## A. Presentation layer (browser) — *partially inspected*
- Pages: `login`, `forgot-password`, `reset-password`, `invitation`, `index` (the app), `preview` (public client review), `offline`.
- `index.html` loads `js/app.js` (`PulseStudioApp`, 513 lines) which owns shell and module lifecycle; `router.js` (hash routes like `#campaigns?plan=<id>`); each feature is a class in `js/modules/<name>/`.
- State: per-module instance fields; no global store (graph shows no store node). Realtime via `RealtimeService`.
- Security-relevant: `permission-service.js` hides UI by role; **not an enforcement point**.
- Heavy `innerHTML` templating with `escapeHTML` (163 / 429 sites; SEC-05).
- PWA: `sw.js` network-first for pages/JS/CSS, cache-first for static; only GET; Supabase/API traffic bypasses it (per file header) so private data isn't cached.
- Communication: `getSupabase()` singleton (PKCE, persisted session in `localStorage` key `pulse_studio_auth_token`, realtime 10 events/s) for table/storage/realtime; `js/services/api.js::callFunction` posts JSON to Edge Functions with the user JWT.

## B. Application layer
Edge Functions (`supabase/functions/*`), all via `serveJson` (CORS allow-list, POST-only, error masking). Pattern (documented in `workflow` header and followed in code read): authenticate → validate (`_shared/validate.ts`) → authorize → mutate with service role using conditional updates → activity log + notifications + audit.

| Function | verify_jwt | Auth in code | Purpose |
|---|---|---|---|
| workflow | true | `getCaller` + `requireStaff` | tasks lifecycle, expense/leave decisions, employee update, comments/file notifications, push subscribe |
| chat | true | staff / admin / author | channels, DMs, messages, reactions, call ringing |
| finance | true | finance roles (+senior for void/reverse/settings) | clients billing, invoices, payments, retainers via `fin_*` RPC |
| kite-drive | true | staff + RLS visibility + admin | Drive linking & token minting |
| content-plan | true | (not read) | content plan operations |
| client-preview | **false** | share token | public client review |
| invite-employee | true | (not read) | invitations |
| accept-invitation | true | `getCaller`, status `onboarding` | activate invited user |
| broadcast | true | (grep) | announcements with 1-h rate limit |
| setup-admin | true | `SETUP_TOKEN` header | one-time bootstrap |
| due-reminders | true | `CRON_SECRET` header | daily digest |
| retainer-billing | (config lines 60–66 not fully read) | `CRON_SECRET` | daily retainer drafts + overdue |

## C. Business logic layer
Placed in three places (a design smell, ARC-01/dual path): (1) Edge Functions (`workflow`: transition table `TRANSITIONS`, `REVIEW_GATED`, reviewer rules); (2) SQL (finance maths in `fin_*`, content-post guard, money blanking, RLS predicates); (3) browser (role gating, form validation, some direct inserts: `finance.js` L318 `expenses`, `hr.js` L549 `leave_requests`).

## D. Data access
`@supabase/supabase-js` only; no ORM/repositories. Browser reads use column-limited selects where required (profiles must not use `*` — `PROFILE_COLUMNS`). Edge Functions use three clients: service role (`adminClient`), caller-scoped (`userClient`, so RLS decides visibility), and the RPC path for finance.

## E. Infrastructure
Vercel static hosting + headers (`vercel.json`) or Apache `.htaccess`; Supabase hosted project; Hostinger for Drive (Apache, PHP, MySQL, `mod_rewrite`); Supabase Storage buckets `task-attachments` (25 MB), `studio-assets` (50 MB), `chat-media`; Web Push (VAPID) from Edge Functions; WebRTC calls (STUN/TURN via `ICE_SERVERS`). No Docker, no IaC, no monitoring config in repo.

## Cross-cutting
- **CSP** identical in `vercel.json`, `.htaccess` and meta tags: `script-src 'self'`, `frame-ancestors 'self' https://sites.google.com`, connect/img/frame allowed to `*.supabase.co` and the Drive host.
- **Secrets:** anon key and Supabase URL are public by design (`env.js`); service role, VAPID private, `KITE_DRIVE_API_SECRET`, `CRON_SECRET`, `SETUP_TOKEN` only in Supabase secrets/Hostinger `config.php` (gitignored).
