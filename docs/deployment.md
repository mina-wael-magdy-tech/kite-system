# PULSE STUDIO OS — Production Deployment Guide

## 1. Architecture
- **Static site**, produced by the production build `npm run build` (`scripts/build.mjs`, output folder `dist/`; on Vercel this is the configured build command in `vercel.json`) and served from any HTTPS host.
- **Supabase** for database, auth, storage, realtime and Edge Functions.

## 2. Deploying on Vercel (recommended path)

The repo already contains `vercel.json`, `package.json` and `scripts/build.mjs`. The build copies **only** `*.html`, `css/`, `js/`, `vendor/`, `assets/`, `fonts/` into `dist/` and generates `dist/env.js` from environment variables, so `supabase/`, `docs/` and scripts are never published.

1. Push this folder to a Git repository. If the repo root is above `pulse-studio-os`, set **Root Directory** to `pulse-studio-os` in Vercel.
2. Import the project in Vercel. Framework preset: **Other**. Build/Output come from `vercel.json` (`npm run build` → `dist`).
3. Project Settings → Environment Variables (Production **and** Preview):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | the **anon / publishable** key only |

   The build fails if either is missing or if the key is a `service_role` key.
4. Deploy, then take the production URL (or your custom domain) and use it **everywhere below**:
   - Supabase Auth → Site URL and redirect URLs (`/invitation.html`, `/reset-password.html`)
   - `supabase secrets set ALLOWED_ORIGINS="https://<your-domain>" APP_URL="https://<your-domain>"`
   - `site_url` in `supabase/config.toml`
5. Preview deployments get random URLs that are **not** in `ALLOWED_ORIGINS`, so the Edge Functions will (correctly) reject them. Either test on a separate staging Supabase project with its own env vars, or add that single preview origin temporarily. Never add `*`.
6. Headers (CSP, HSTS, `nosniff`, referrer/permissions policy, `frame-ancestors`) are set in `vercel.json`. `.htaccess` is for Apache only and is ignored by Vercel. If you edit the CSP, change it in `vercel.json` **and** the `<meta>` tag in each HTML page.
7. Custom domain: Vercel → Domains. HTTPS and certificates are automatic.

> The `SUPABASE_ANON_KEY` is public by design and ends up in `env.js`. Security comes from RLS, not from hiding it.

## 3. Other hosts (Apache / Nginx)
### Security headers
The pages carry a strict Content-Security-Policy via `<meta>`. Headers are better and are the only way to set `frame-ancestors`, so configure the host too.

#### Apache / Hostinger
Use the provided `.htaccess` (needs `mod_headers`, `mod_rewrite`). Adjust the `frame-ancestors` list and, if you use a custom Supabase domain, `connect-src`.

#### Nginx
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://*.supabase.co https://our-kites.kiteagency-eg.com; media-src 'self' blob: https://*.supabase.co https://our-kites.kiteagency-eg.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://our-kites.kiteagency-eg.com; frame-src 'self' https://our-kites.kiteagency-eg.com; object-src 'none'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://sites.google.com" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()" always;
location = /env.js { add_header Cache-Control "no-store"; }
location ~* \.(html|js)$ { add_header Cache-Control "no-cache"; }
```

#### Netlify / Cloudflare Pages
Create a `_headers` file with the same header values under `/*`.

## 4. Pre-flight
1. HTTPS enforced, certificate valid, HSTS present.
2. Vercel env vars hold the production URL and **anon** key only; no other secrets in the repo or Vercel build output.
3. Auth: signups **off**, 12-char passwords, real SMTP, redirect URLs set (`supabase config push`).
4. Edge Function secrets set (`ALLOWED_ORIGINS`, `APP_URL`); `setup-admin` deleted and `SETUP_TOKEN` unset after bootstrap.
5. Backups: enable daily backups (Supabase Pro) or schedule `pg_dump`; **test a restore**.
6. Walk through `production-checklist.md` and the runbook's pre-deployment checklist.

## 5. Releasing changes
The full, ordered procedure for a release is `docs/PHASE_8_DEPLOYMENT_RUNBOOK.md`; the audit behind it is `docs/PHASE_8_RELEASE_READINESS_AUDIT.md`.
Order of layers: **database -> Edge Functions (`kite-drive` after the Hostinger PHP) -> Hostinger PHP -> cron -> web app last.**

- **Front end:** deploy through the production build (on Vercel: push to the production branch, `npm run build` runs and publishes `dist/`; elsewhere run `npm run build` with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set and upload `dist/`). Do not upload the source folders. The service worker cache id changes with every build, and HTML/JS are served with `Cache-Control: no-cache`.
  Deploy the web app **last**: it calls database functions and Edge Functions that must already exist.
- **Database:** add a new numbered file in `supabase/migrations/`, test it on a staging project, then apply it **manually, one file at a time, each file as a single script, in numeric order** (Dashboard SQL editor, or `psql -v ON_ERROR_STOP=1 -f supabase/migrations/NNN_name.sql`).
  **Never run `supabase db push` on the live project:** its migration history table is empty, so `db push` would try to apply every migration from the first one. Check what is already applied with the read-only probes in the runbook (R0) before choosing the first file. Never edit an applied migration. Roll back with the scripts in `supabase/maintenance/` (`rollback-036/037/038.sql`) or the ROLLBACK text in each migration header.
  - **If migration 017 is ever re-run** (it re-creates the original finance functions and policies), re-apply in exactly this order: **022 -> 028 -> 033 -> 035 -> 036 -> 037**. Skipping 022 re-opens Finance to the finance-manager and accountant roles. Do not re-run 024 afterwards without re-applying 036. Migration 038 is unaffected.
- **Functions:** `supabase functions deploy <name>`. Deploy `kite-drive` only after the Kite Drive PHP is on Hostinger. Roll back by redeploying the previous commit's version.
- **Scheduled jobs:** `due-reminders` and `retainer-billing` are created by hand in the Dashboard and need the owner's approval (see `docs/background-jobs.md`).

## 6. Monitoring
- Supabase Dashboard → Logs: Edge Function errors, Auth failures, Postgres errors.
- Admin Control Center → Audit log: invitations, task/expense/leave decisions.
- Add an uptime monitor on `/login.html` and a Supabase alert on function error rate.
