# 01 — Project inventory

## Stack (IMPLEMENTED)
| Aspect | Finding | Evidence |
|---|---|---|
| Type | Static SPA + BaaS + satellite PHP service | repo layout |
| Languages | JavaScript (ES modules, no TS in browser), TypeScript (Deno Edge Functions), SQL (PL/pgSQL), PHP 8 (`declare(strict_types=1)`, `match`, `never`) | files |
| Frontend | Vanilla JS, HTML pages (`index/login/forgot/reset/invitation/preview/offline`), CSS tokens; vendored Chart.js, Lucide, pptxgenjs, pdf bundle, qrcode, supabase-js | `vendor/`, `README.md` |
| Backend | Supabase: Postgres 15+, Auth (PKCE), Realtime, Storage (3 buckets), 12 Edge Functions on Deno (`npm:@supabase/supabase-js@2.118.0`) | `supabase/` |
| Satellite | Kite Drive PHP API + MySQL (via legacy `db.php`, not in repo) on Hostinger | `integrations/kite-drive/` |
| Build | `node scripts/build.mjs` copies public files to `dist/`, writes `dist/env.js` from env vars, stamps `sw.js` (build id + precache list) | `scripts/build.mjs` |
| Hosting | Vercel (`vercel.json`) or Apache/Hostinger (`.htaccess`); Google Sites embedding supported | `docs/deployment.md` |
| Package manager | npm, only for build script and `supabase/tests` (PGlite) | `package.json` |
| Tests | One manual Node script (`supabase/tests/verify-rls.mjs`, PGlite) | |
| CI/CD | none in repo (Vercel git deploys presumed; unverified) | no `.github/` |

## Size
183 tracked files; ~23k lines in `js/`, `supabase/`, `integrations/`, `scripts/`. Largest: `chat.js` 1194, `content-plan.js` 1094, `kite-drive/api/index.php` 1089, `tasks.js` 1081, `drive-panel.js` 904, `002_rls_policies.sql` 805, `017_finance_invoicing.sql` 790, `workflow/index.ts` 676. 73 commits on the current branch (`git log --oneline | wc -l`).

## Directory registry
| Dir | Purpose | Depends on | Notes |
|---|---|---|---|
| `js/` root (`app.js`, `router.js`, `config.js`, `supabase-client.js`, `pwa.js`, `offline.js`, `ui-init.js`) | shell, routing, config, client singleton | supabase vendor | `getSupabase()` is the hub (118 edges) |
| `js/auth/` | login, invitation, guard, `AuthService` | supabase-client | |
| `js/modules/<feature>/` (25 files) | one module class per feature | services, utils, ui | UI + data access + some rules mixed (no separate data layer) |
| `js/services/` | api (`callFunction`), realtime, push, notification, call (WebRTC), finance-pdf, toast, money | supabase-client | |
| `js/utils/`, `js/ui/`, `js/permissions/`, `js/preview/` | helpers (`escapeHTML` 94 edges), dialogs, pagination, client-side permission checks, public preview page | | permissions here are **UX only**; real enforcement is RLS/Edge |
| `supabase/migrations/` | 19 SQL migrations 001–019 | | live migration history is empty (project memory) → applied manually, one at a time |
| `supabase/functions/` | 12 Edge Functions + `_shared/` | service role | |
| `supabase/tests/`, `seed*.sql`, `maintenance/`, `templates/` | RLS tests, seed, test-data removal, invite email | | |
| `integrations/kite-drive/` | files to deploy on Hostinger | MySQL, legacy auth | `config.php` is gitignored and present locally |
| `docs/` | operational docs | | accuracy vs code not fully checked |
| `dist/`, `assets/`, `fonts/`, `vendor/`, `css/` | build output (ignored), static assets | | |

## Architecture classification (actual)
Layered, client-heavy **two-tier + BaaS** with a small **service-per-concern Edge Function layer** and one external **satellite system** bridged by signed tokens. Not microservices, not event-driven in the message-broker sense (events are DB rows + Realtime + push).

## Duplicate / legacy
- Role lists in 3 layers (ARC-01).
- Legacy money columns retained but blanked (DAT-02).
- Kite Drive is a legacy PHP product with its own users/sessions, now fronted by the new system.
