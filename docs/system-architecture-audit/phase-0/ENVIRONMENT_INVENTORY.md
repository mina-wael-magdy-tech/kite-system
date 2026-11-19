# Environment Inventory
Date: 2026-11-07. Evidence classes: **REPO** (files read), **LOCAL** (run on this machine), **STAGING/PROD** (live evidence). No STAGING or PROD evidence was obtainable. No secret values were read or are shown; names only.

## Components and relationships (REPO)
| # | Component | Technology | Talks to |
|---|---|---|---|
| 1 | SPA / frontend | static vanilla-JS ES modules, PWA service worker, built by `scripts/build.mjs` | Supabase (REST/RPC/Realtime/Storage/Functions); Kite Drive PHP from the browser with an HMAC token |
| 2 | Supabase Database | Postgres + RLS; migrations 001-019, `seed.sql` | Auth, Storage, Realtime |
| 3 | Supabase Auth | `config.toml`: sign-up off, anonymous off, confirmations on, min password 12 | SPA, `invite-employee`, `accept-invitation` |
| 4 | Edge Functions | Deno: accept-invitation, broadcast, chat, client-preview, content-plan, due-reminders, finance, invite-employee, kite-drive, retainer-billing, setup-admin, workflow (+ `_shared`) | DB (service role), web-push, Kite Drive |
| 5 | Supabase Storage | buckets/policies from migrations 004, 007, 009, 016 | SPA, chat |
| 6 | Hostinger PHP API | `integrations/kite-drive/api/index.php`, `file.php` (legacy `db.php`/`auth.php` are not in the repo) | SPA (browser); `kite-drive` function signs tokens |
| 7 | Kite Drive | the Hostinger PHP site clients log in to (`our-kites.kiteagency-eg.com` in the CSP) | PHP API, MySQL, `uploads/` |
| 8 | External | Web Push (VAPID), WebRTC STUN/TURN (`ICE_SERVERS`), Google Sites embedding | SPA, `_shared/push.ts` |

## Environments
| Env | URL | Frontend | Database | Edge Functions | PHP | Evidence |
|---|---|---|---|---|---|---|
| Local dev | none defined (config comments mention `supabase start`) | static files | none | not run | none | REPO |
| Testing | n/a | n/a | in-process PGlite in `supabase/tests` | none | none | LOCAL: 153 passed / 0 failed |
| Staging | **none evidenced**; `docs/deployment.md` recommends one but none is named | - | - | - | - | NOT ACCESSIBLE / may not exist |
| Production | `https://kite-system.vercel.app` (`config.toml` site_url; a custom domain is unknown) | Vercel | project ref `qsollulgrbxksenovaee` from `config.toml` (a repo value, not proof it is the live project) | manual `supabase functions deploy` | Hostinger, `our-kites.kiteagency-eg.com` (from CSP) | REPO only; live state NOT VERIFIED |

Warning: the repo does not prove live configuration. The repo's `env.js` is a placeholder; real values come from Vercel env vars.

## Secret / config names (values never read)
| Name | Used by | How presence could be verified (all NOT ACCESSIBLE here) |
|---|---|---|
| SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY, ICE_SERVERS | Vercel build | `vercel env ls` (names) |
| ALLOWED_ORIGINS, APP_URL, CRON_SECRET, KITE_DRIVE_URL, KITE_DRIVE_API_SECRET, VAPID_PRIVATE_KEY, VAPID_SUBJECT, REMINDER_TZ | Edge Functions | `supabase secrets list` |
| SETUP_TOKEN | `setup-admin` (should be gone after bootstrap) | same |
| shared secret in `api/config.php` | PHP | hosting panel/SSH |
